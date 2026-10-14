import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { CollectorDatabase } from "./database.js";
import { analysisResultSchema, type ReviewAction } from "./domain.js";
import { ConnectionHealth } from "./health.js";

const reviewRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accept"), version: z.number().int().positive(), note: z.string().max(2_000).optional() }),
  z.object({ type: z.literal("dismiss"), version: z.number().int().positive(), note: z.string().min(1).max(2_000) }),
  z.object({
    type: z.literal("correct"),
    version: z.number().int().positive(),
    note: z.string().max(2_000).optional(),
    result: analysisResultSchema,
  }),
]);

const modelConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1).max(200),
  apiKey: z.string().min(1).max(4_096).nullable().optional(),
});

const groupWhitelistSchema = z.object({
  groups: z.array(z.string().regex(/^\d+$/, "群号只能包含数字")).min(1).max(100),
}).transform(({ groups }) => [...new Set(groups)]);

const nahidaAvatar = readFileSync(new URL("../assets/nahida-avatar.png", import.meta.url));

export interface AdminServerOptions {
  host?: "127.0.0.1" | "::1" | "localhost" | "0.0.0.0";
  port: number;
  token: string;
  store: CollectorDatabase;
  health: ConnectionHealth;
  getModelConfig?: () => { baseUrl: string; model: string; hasApiKey: boolean };
  updateModelConfig?: (values: z.infer<typeof modelConfigSchema>) => void;
  getGroupWhitelist?: () => string[];
  updateGroupWhitelist?: (groups: string[]) => void;
}

export class AdminServer {
  readonly options: AdminServerOptions;
  #server: ReturnType<typeof createServer> | null = null;

  constructor(options: AdminServerOptions) {
    if (options.token.length < 32) throw new Error("管理令牌至少需要 32 个字符");
    this.options = options;
  }

  async start(): Promise<number> {
    if (this.#server) throw new Error("管理工作台已经启动");
    const host = this.options.host ?? "127.0.0.1";
    if (!new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]).has(host)) {
      throw new Error("管理工作台监听地址无效");
    }
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(this.options.port, host);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定管理工作台端口");
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      this.html(response, workbenchHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/assets/nahida-avatar.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": nahidaAvatar.length });
      response.end(nahidaAvatar);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      this.json(response, 404, { error: "页面不存在" });
      return;
    }
    if (!this.isAuthorized(request.headers["x-admin-token"])) {
      this.json(response, 401, { error: "管理令牌无效" });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/status") {
        this.json(response, 200, {
          health: this.options.health.evaluate(),
          queues: this.options.store.getRuntimeSummary(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/reviews") {
        this.json(response, 200, { items: this.options.store.listOpenReviews() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/information") {
        this.json(response, 200, { items: this.options.store.listInformation() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/model-config") {
        if (!this.options.getModelConfig) throw new Error("模型设置不可用");
        this.json(response, 200, this.options.getModelConfig());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/model-config") {
        if (!this.options.updateModelConfig) throw new Error("模型设置不可用");
        this.requireJson(request);
        const values = modelConfigSchema.parse(await readJson(request));
        this.options.updateModelConfig(values);
        this.json(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/group-whitelist") {
        if (!this.options.getGroupWhitelist) throw new Error("群白名单设置不可用");
        this.json(response, 200, { groups: this.options.getGroupWhitelist() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/group-whitelist") {
        if (!this.options.updateGroupWhitelist) throw new Error("群白名单设置不可用");
        this.requireJson(request);
        const groups = groupWhitelistSchema.parse(await readJson(request));
        this.options.updateGroupWhitelist(groups);
        this.json(response, 200, { ok: true, groups });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/dead-letters") {
        this.json(response, 200, { items: this.options.store.listDeadLetters() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/retries") {
        this.json(response, 200, { items: this.options.store.listWaitingRetries() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/export.csv") {
        response.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=qq-tech-info.csv",
        });
        response.end(this.options.store.exportCsv());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/analysis/resume") {
        this.requireJson(request);
        await readJson(request);
        this.options.store.resumeAnalysisQueue();
        this.json(response, 200, { ok: true });
        return;
      }
      const reviewMatch = url.pathname.match(/^\/api\/reviews\/(\d+)$/);
      if (request.method === "POST" && reviewMatch) {
        this.requireJson(request);
        const reviewId = Number(reviewMatch[1]);
        const body = reviewRequestSchema.parse(await readJson(request));
        let action: ReviewAction;
        if (body.type === "correct") {
          action = body.note === undefined
            ? { type: "correct", result: body.result }
            : { type: "correct", result: body.result, note: body.note };
        } else if (body.type === "dismiss") {
          action = { type: "dismiss", note: body.note };
        } else {
          action = body.note === undefined
            ? { type: "accept" }
            : { type: "accept", note: body.note };
        }
        const { version } = body;
        this.options.store.resolveReview(reviewId, version, action);
        this.json(response, 200, { ok: true });
        return;
      }
      const deadLetterMatch = url.pathname.match(/^\/api\/dead-letters\/(\d+)\/requeue$/);
      if (request.method === "POST" && deadLetterMatch) {
        this.requireJson(request);
        await readJson(request);
        const jobId = this.options.store.requeueDeadLetter(Number(deadLetterMatch[1]));
        this.json(response, 200, { ok: true, jobId });
        return;
      }
      const retryMatch = url.pathname.match(/^\/api\/retries\/(\d+)\/now$/);
      if (request.method === "POST" && retryMatch) {
        this.requireJson(request);
        await readJson(request);
        this.options.store.retryJobNow(Number(retryMatch[1]));
        this.json(response, 200, { ok: true });
        return;
      }
      this.json(response, 404, { error: "接口不存在" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求处理失败";
      const conflict = message.includes("版本冲突") || message.includes("已经处理");
      this.json(response, conflict ? 409 : 400, { error: message });
    }
  }

  private requireJson(request: IncomingMessage): void {
    if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
      throw new Error("写操作只接受 application/json");
    }
  }

  private isAuthorized(value: string | string[] | undefined): boolean {
    if (typeof value !== "string") return false;
    const provided = Buffer.from(value);
    const expected = Buffer.from(this.options.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private html(response: ServerResponse, body: string): void {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("请求内容不能超过 64 KiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求内容不是有效 JSON");
  }
}

const workbenchHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>技术信息控制台</title><style>
:root{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#163c2d;background:#f1f8e9;--deep:#07583b;--green:#12975a;--mint:#e9f8dd;--gold:#d9ad42;--line:#b9d99f}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 5%,#d8f0b9 0 2%,transparent 15%),radial-gradient(circle at 91% 15%,#d9efbb 0 1%,transparent 14%),linear-gradient(135deg,#f7fbed,#edf8e7 55%,#f8f6df)}body:before,body:after{content:"";position:fixed;z-index:-1;width:320px;height:320px;border:2px solid #d9ad4244;transform:rotate(45deg);border-radius:38%;top:-210px;left:-90px}body:after{top:auto;left:auto;right:-120px;bottom:-230px}.hero{position:relative;overflow:hidden;padding:26px max(24px,calc((100% - 1160px)/2));color:#fff;background:linear-gradient(115deg,#07583b,#0f7b49 68%,#7cab45);border-bottom:3px solid var(--gold);box-shadow:0 8px 28px #07583b44}.hero:after{content:"✦  ❀  ✦  ❀  ✦";position:absolute;right:4%;top:12px;color:#fff7bd66;font-size:54px;letter-spacing:15px;transform:rotate(-8deg)}.brand{display:flex;align-items:center;gap:15px;position:relative;z-index:1}.sigil{display:grid;place-items:center;width:58px;height:58px;transform:rotate(45deg);border:2px solid #f8df7e;border-radius:18px;background:#fff2;box-shadow:inset 0 0 0 5px #ffffff18}.sigil span{transform:rotate(-45deg);font-size:30px;color:#fff9bd}.mascot{position:absolute;z-index:2;right:max(16px,calc((100% - 1160px)/2));bottom:-13px;width:116px;height:auto;filter:drop-shadow(0 5px 5px #073c2d55)}.hero h1{margin:0 0 4px;font-size:28px;letter-spacing:2px}.hero p{margin:0;color:#eafbd9}.hero-state{margin-left:auto;margin-right:120px;padding:10px 18px;border:1px solid #f4df8a;border-radius:999px;background:#ffffff16;font-weight:700}.hero-state:before{content:"●";color:#a8ed73;margin-right:8px}main{max-width:1160px;margin:auto;padding:26px}.panel,.card{position:relative;background:linear-gradient(145deg,#fffffff5,#fbfff8ee);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 7px 24px #315f3620}.panel:before,.card:before{content:"";position:absolute;left:11px;top:11px;width:8px;height:8px;border-left:2px solid var(--gold);border-top:2px solid var(--gold)}.login{max-width:540px;margin:72px auto;border-color:#d7b85e;padding:30px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:13px;margin:17px 0}.metric{overflow:hidden;min-height:104px}.metric:after{content:"❀";position:absolute;right:12px;bottom:5px;color:#94c86d2b;font-size:44px}.metric strong{display:block;margin-top:9px;font-size:27px;color:var(--green)}.toolbar h2{margin:0;color:var(--deep)}.tabs{display:flex;gap:4px;margin:25px 0 14px;border-bottom:1px solid #c7daa7;overflow-x:auto}.tabs button{border:0;border-radius:10px 10px 0 0;background:transparent;padding:12px 18px;white-space:nowrap}.tabs button.active{color:#fff;background:linear-gradient(135deg,#0d9859,#087044);box-shadow:0 -2px 0 var(--gold)}.info-heading{margin:20px 4px 8px;color:var(--deep)}.item{margin:11px 0;border-left:4px solid #8abc59}.item.priority{border:2px solid #d9ad42;border-left:6px solid #0d9859;background:linear-gradient(135deg,#fffef4,#edfae8);box-shadow:0 9px 28px #997a2030}.item summary{cursor:pointer;color:#124f35;font-weight:700}.item summary::marker{color:var(--green)}.badge{margin-left:9px;padding:3px 8px;border-radius:999px;color:#fff;background:#0d9859;font-size:12px}.muted{color:#5f776a;font-size:13px}.error{color:#aa2929}.warning{color:#8b6100}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.spacer{flex:1}.group-list{display:grid;gap:8px;margin-top:16px}.group-entry{padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#f7fcf3}button,input,textarea{font:inherit;border:1px solid #99bb92;border-radius:9px;padding:10px 13px}input,textarea{background:#fffffff2;color:#173f2e}button{cursor:pointer;background:#e8f5df;color:#164c34;font-weight:600}button:hover{filter:brightness(.97);transform:translateY(-1px)}button.primary{color:#fff;border-color:#087849;background:linear-gradient(135deg,#13a35d,#087447);box-shadow:0 4px 10px #08784933}button.danger{color:#9b2424;background:#fff2ef}.settings{max-width:760px}.field{display:grid;gap:6px;margin:14px 0}.field span{font-size:13px;font-weight:700;color:#315d47}.field input{width:100%}.model-note{padding:12px;border-radius:10px;background:#eef8e8;border-left:3px solid var(--gold)}textarea{width:100%;min-height:130px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#app[hidden],#login[hidden],section[hidden]{display:none}@media(max-width:650px){.hero,main{padding:18px}.mascot{right:8px;width:88px}.hero-state{display:none}.hero h1{font-size:22px}.hero p{max-width:210px}.grid{grid-template-columns:1fr 1fr}.toolbar{align-items:flex-start}.toolbar .spacer{display:none}.tabs{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;border:0;overflow:visible}.tabs button{border:1px solid var(--line);border-radius:10px}.tabs button.active{box-shadow:none}.item{padding:14px}}
</style></head><body><header class="hero"><div class="brand"><div class="sigil"><span>❀</span></div><div><h1>技术信息控制台</h1><p>草木知讯 · 本机无人值守采集与分析</p></div><div id="heroState" class="hero-state">等待连接</div></div><img class="mascot" src="/assets/nahida-avatar.png" alt="小草神"></header><main>
<div id="login" class="panel login"><h2>输入管理令牌</h2><p class="muted">令牌来自 .env 的 ADMIN_TOKEN，可以安全地记住在这台本机浏览器中。</p><form id="loginForm"><div class="row"><input id="token" type="password" minlength="32" required autocomplete="current-password" class="spacer"><button class="primary">进入工作台</button></div><label class="row muted"><input id="rememberToken" type="checkbox" checked>在此电脑记住管理令牌</label></form><p id="loginError" class="error"></p></div>
<div id="app" hidden><div class="row toolbar"><h2>运行总览</h2><span class="spacer"></span><button id="export">导出 CSV</button><button id="refresh">刷新</button><button id="logout">退出</button></div><div id="alert"></div><div id="metrics" class="grid"></div>
<div class="tabs"><button data-tab="information" class="active">❀ 最新信息</button><button data-tab="reviews">待审核</button><button data-tab="retries">等待重试</button><button data-tab="dead">死信任务</button><button data-tab="groups">采集群</button><button data-tab="model">模型设置</button></div>
<section id="information"></section><section id="reviews" hidden></section><section id="retries" hidden></section><section id="dead" hidden></section><section id="groups" hidden><div class="card settings"><h3>采集群白名单</h3><p class="model-note">只采集列表中的群；添加或移除后立即生效。</p><form id="groupForm" class="row"><input id="groupId" inputmode="numeric" pattern="[0-9]+" required placeholder="输入 QQ 群号" class="spacer"><button class="primary">添加群</button></form><div id="groupList" class="group-list"></div></div></section><section id="model" hidden><form id="modelForm" class="card settings"><h3>使用自己的模型 API</h3><p class="model-note">每台电脑单独保存模型设置。API Key 不会显示在页面，也不会与其他安装共享。</p><label class="field"><span>OpenAI 兼容接口地址</span><input id="modelBaseUrl" type="url" required placeholder="https://api.example.com/v1"></label><label class="field"><span>模型名称</span><input id="modelName" required maxlength="200" placeholder="model-name"></label><label class="field"><span>API Key（留空则保持原值）</span><input id="modelApiKey" type="password" maxlength="4096" autocomplete="new-password" placeholder="sk-..."></label><label class="row"><input id="clearModelApiKey" type="checkbox">清除已保存的 API Key（本地模型无需密钥）</label><p id="modelKeyState" class="muted"></p><button class="primary">保存并立即使用</button></form></section></div>
</main><script>
const $=s=>document.querySelector(s);let token=localStorage.getItem('adminToken')||sessionStorage.getItem('adminToken')||'';
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'x-admin-token':token,...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||'请求失败');return data}
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
function button(text,action,cls=''){const node=el('button',text,cls);node.onclick=async()=>{node.disabled=true;try{await action();await load()}catch(error){alert(error.message)}finally{node.disabled=false}};return node}
async function load(){const [status,information,reviews,retries,dead,groups,model]=await Promise.all([api('/api/status'),api('/api/information'),api('/api/reviews'),api('/api/retries'),api('/api/dead-letters'),api('/api/group-whitelist'),api('/api/model-config')]);renderStatus(status);renderInformation(information.items);renderReviews(reviews.items);renderRetries(retries.items);renderDead(dead.items);renderGroups(groups.groups);renderModel(model)}
function renderStatus(data){const q=data.queues,h=data.health;$('#heroState').textContent=h.transport==='connected'&&h.qq==='online'?'无人值守运行中':'等待采集连接';const alertBox=$('#alert');alertBox.replaceChildren();if(q.analysisPaused){const p=el('div','分析队列已暂停：'+(q.pauseReason||'未知原因'),'card warning');p.append(' ',button('配置修复后恢复',()=>api('/api/analysis/resume',{method:'POST',body:'{}'}),'primary'));alertBox.append(p)}
const metrics=[['采集连接',h.transport],['NapCat',h.napCat],['QQ 账号',h.qq],['消息总数',q.messageCount],['等待分析',q.queuedCount],['等待重试',q.retryWaitCount],['待审核',q.openReviewCount],['死信',q.deadLetterCount]];const box=$('#metrics');box.replaceChildren(...metrics.map(([name,value])=>{const d=el('div',undefined,'card metric');d.append(el('span',name,'muted'),el('strong',String(value)));return d}))}
function renderInformation(items){const box=$('#information');box.replaceChildren();if(!items.length){box.append(el('div','还没有完成分类的信息。','card muted'));return}const ordinary=new Set(['求助问答','观点讨论','闲聊','其他']);const groups=[['重点信息',items.filter(item=>!ordinary.has(item.result.informationType)),true],['其他分类',items.filter(item=>ordinary.has(item.result.informationType)),false]];for(const [title,group,priority] of groups){if(!group.length)continue;box.append(el('h3',title,'info-heading'));for(const item of group){const r=item.result,d=el('details',undefined,'card item'+(priority?' priority':'')),s=el('summary');s.append(el('span',r.informationType+' · '+r.summary));if(priority)s.append(el('span','重点','badge'));d.append(s,el('p',item.normalizedText),el('div',[r.product,r.version,...r.technicalDomains].filter(Boolean).join(' · '),'muted'),el('div','群 '+item.groupId+' · '+new Date(item.receivedAt).toLocaleString(),'muted'));if(r.needsReview)d.append(el('div','待审核：'+r.reviewIssue,'warning'));box.append(d)}}}
function renderReviews(items){const box=$('#reviews');box.replaceChildren();if(!items.length){box.append(el('div','当前没有待审核内容。','card muted'));return}for(const item of items){const d=el('article',undefined,'card item');d.append(el('h3','#'+item.id+' · '+item.issueCode),el('p',item.normalizedText),el('div','模型分类：'+item.result.informationType+' · '+item.result.summary,'muted'));const actions=el('div',undefined,'row');actions.append(button('确认结果',()=>api('/api/reviews/'+item.id,{method:'POST',body:JSON.stringify({type:'accept',version:item.version})}),'primary'),button('修正 JSON',async()=>{const raw=prompt('修改结构化结果 JSON',JSON.stringify(item.result,null,2));if(raw===null)return;await api('/api/reviews/'+item.id,{method:'POST',body:JSON.stringify({type:'correct',version:item.version,result:JSON.parse(raw),note:'通过工作台人工修正'})})}),button('标记无关',async()=>{const note=prompt('请输入标记无关的原因');if(!note)return;await api('/api/reviews/'+item.id,{method:'POST',body:JSON.stringify({type:'dismiss',version:item.version,note})})},'danger'));d.append(actions);box.append(d)}}
function renderRetries(items){const box=$('#retries');box.replaceChildren();if(!items.length){box.append(el('div','当前没有等待重试的任务。','card muted'));return}for(const item of items){const d=el('article',undefined,'card item');d.append(el('h3','任务 #'+item.id+' · '+(item.errorCode||'未知错误')),el('p',item.normalizedText),el('p',(item.errorSummary||'没有错误详情')+' · 下次重试 '+new Date(item.nextAttemptAt).toLocaleString(),'muted'),button('立即重试',()=>api('/api/retries/'+item.id+'/now',{method:'POST',body:'{}'}),'primary'));box.append(d)}}
function renderDead(items){const box=$('#dead');box.replaceChildren();if(!items.length){box.append(el('div','当前没有需要处理的死信任务。','card muted'));return}for(const item of items){const d=el('article',undefined,'card item');d.append(el('h3','任务 #'+item.id+' · '+(item.errorCode||'未知错误')),el('p',item.normalizedText),el('p',(item.errorSummary||'没有错误详情')+' · 已尝试 '+item.attemptCount+' 次','muted'),button('重新入队',()=>api('/api/dead-letters/'+item.id+'/requeue',{method:'POST',body:'{}'}),'primary'));box.append(d)}}
let groupWhitelist=[];function renderGroups(groups){groupWhitelist=groups;const box=$('#groupList');box.replaceChildren(...groups.map(group=>{const row=el('div',undefined,'row group-entry');row.append(el('strong','群 '+group),el('span',undefined,'spacer'),button('移除',()=>api('/api/group-whitelist',{method:'POST',body:JSON.stringify({groups:groupWhitelist.filter(value=>value!==group)})}),'danger'));return row}))}
function renderModel(model){$('#modelBaseUrl').value=model.baseUrl;$('#modelName').value=model.model;$('#modelKeyState').textContent=model.hasApiKey?'已保存 API Key；留空不会覆盖。':'当前未保存 API Key，适合本地模型。'}
async function enter(){try{await api('/api/status');const storage=$('#rememberToken').checked?localStorage:sessionStorage;storage.setItem('adminToken',token);$('#login').hidden=true;$('#app').hidden=false;await load()}catch(error){localStorage.removeItem('adminToken');sessionStorage.removeItem('adminToken');$('#loginError').textContent=error.message}}
$('#loginForm').onsubmit=e=>{e.preventDefault();token=$('#token').value.trim();void enter()};$('#groupForm').onsubmit=async e=>{e.preventDefault();const group=$('#groupId').value.trim();try{await api('/api/group-whitelist',{method:'POST',body:JSON.stringify({groups:[...groupWhitelist,group]})});$('#groupId').value='';await load()}catch(error){alert(error.message)}};$('#modelForm').onsubmit=async e=>{e.preventDefault();const key=$('#modelApiKey').value,clear=$('#clearModelApiKey').checked;const body={baseUrl:$('#modelBaseUrl').value,model:$('#modelName').value,...(clear?{apiKey:null}:key?{apiKey:key}:{})};try{await api('/api/model-config',{method:'POST',body:JSON.stringify(body)});$('#modelApiKey').value='';$('#clearModelApiKey').checked=false;await load();alert('模型设置已生效')}catch(error){alert(error.message)}};$('#refresh').onclick=()=>void load().catch(e=>alert(e.message));$('#export').onclick=async()=>{try{const response=await fetch('/api/export.csv',{headers:{'x-admin-token':token}});if(!response.ok)throw new Error('导出失败');const a=document.createElement('a');a.href=URL.createObjectURL(await response.blob());a.download='qq-tech-info.csv';a.click();URL.revokeObjectURL(a.href)}catch(error){alert(error.message)}};$('#logout').onclick=()=>{localStorage.removeItem('adminToken');sessionStorage.removeItem('adminToken');location.reload()};document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));['information','reviews','retries','dead','groups','model'].forEach(id=>$('#'+id).hidden=b.dataset.tab!==id)});if(token)void enter();
</script></body></html>`;
