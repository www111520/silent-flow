import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAnalyzer } from "../src/analyzer.js";
import { loadConfig, saveGroupWhitelist, saveModelConfig } from "../src/config.js";
import { CollectorDatabase } from "../src/database.js";
import { ConnectionHealth } from "../src/health.js";
import { createOneBotEventHandler } from "../src/onebot.js";
import { AnalysisWorkerLoop } from "../src/runtime.js";
import { OneBotReverseWebSocketServer } from "../src/server.js";
import { startApplication } from "../src/main.js";

const temporaryDirectories: string[] = [];
const servers: OneBotReverseWebSocketServer[] = [];

function openDatabase(): CollectorDatabase {
  const directory = mkdtempSync(join(tmpdir(), "qq-collector-"));
  temporaryDirectories.push(directory);
  return new CollectorDatabase(join(directory, "collector.sqlite"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("运行配置", () => {
  const baseEnvironment = {
    ONEBOT_TOKEN: "x".repeat(32),
    ADMIN_TOKEN: "a".repeat(32),
    SENDER_SALT: "s".repeat(16),
    GROUP_WHITELIST: "100, 200",
    LLM_BASE_URL: "http://127.0.0.1:11434/v1",
    LLM_MODEL: "local-model",
  };

  it("OneBot 只接受回环监听，管理工作台可供局域网手机访问", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.ONEBOT_HOST).toBe("127.0.0.1");
    expect(config.GROUP_WHITELIST).toEqual(new Set(["100", "200"]));
    expect(() => loadConfig({ ...baseEnvironment, ONEBOT_HOST: "0.0.0.0" })).toThrow(
      "OneBot 必须监听回环地址",
    );
    expect(loadConfig({ ...baseEnvironment, ADMIN_HOST: "0.0.0.0" }).ADMIN_HOST).toBe("0.0.0.0");
  });

  it("拒绝弱访问令牌和空群白名单", () => {
    expect(() => loadConfig({ ...baseEnvironment, ONEBOT_TOKEN: "short" })).toThrow();
    expect(() => loadConfig({ ...baseEnvironment, ADMIN_TOKEN: "short" })).toThrow();
    expect(() => loadConfig({ ...baseEnvironment, GROUP_WHITELIST: " , " })).toThrow(
      "群白名单不能为空",
    );
  });

  it("原子保存每台安装实例自己的模型配置", () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-model-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".env");
    writeFileSync(path, "LLM_BASE_URL=http://old/v1\nLLM_MODEL=old\nGROUP_WHITELIST=1\nOTHER=value\n");

    saveModelConfig(path, {
      baseUrl: "https://user.example/v1",
      model: "user-model",
      apiKey: "user-secret",
    });
    saveGroupWhitelist(path, ["100", "200"]);

    expect(readFileSync(path, "utf8")).toContain('LLM_BASE_URL="https://user.example/v1"');
    expect(readFileSync(path, "utf8")).toContain('LLM_API_KEY="user-secret"');
    expect(readFileSync(path, "utf8")).toContain('GROUP_WHITELIST="100,200"');
    expect(readFileSync(path, "utf8")).toContain("OTHER=value");
  });
});

describe("反向 WebSocket 服务", () => {
  it("拒绝未授权连接，并接收已授权的白名单群消息", async () => {
    const store = openDatabase();
    const health = new ConnectionHealth();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(["20001"]),
      senderSalt: "test-only-salt",
      onHeartbeat: (good, online) => health.oneBotHeartbeat(good, online),
    });
    const token = "secure-token-".padEnd(32, "x");
    const server = new OneBotReverseWebSocketServer({
      port: 0,
      token,
      health,
      handleEvent: handler,
      pingIntervalMs: 20,
      onConnectionEvent: (type) => store.recordConnectionEvent(type),
    });
    servers.push(server);
    const port = await server.start();

    await new Promise<void>((resolve) => {
      const unauthorized = new WebSocket(`ws://127.0.0.1:${port}`);
      unauthorized.once("error", () => resolve());
    });

    const authorized = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      authorized.once("open", () => resolve());
      authorized.once("error", reject);
    });
    authorized.send(JSON.stringify({
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      group_id: 20001,
      message_id: 30001,
      user_id: 40001,
      time: 1_700_000_000,
      message: [{ type: "text", data: { text: "安全更新" } }],
    }));
    await waitFor(() => store.count("messages") === 1);
    expect(health.evaluate().transport).toBe("connected");
    await new Promise<void>((resolve) => {
      authorized.once("close", () => resolve());
      authorized.close();
    });
    await waitFor(() => store.count("connection_events") === 2);
    expect(
      store.database.prepare(
        "SELECT event_type FROM connection_events ORDER BY id",
      ).all().map((row) => row.event_type),
    ).toEqual(["connected", "disconnected"]);
    store.close();
  });
});

describe("应用入口", () => {
  it("可以从环境配置启动并安全停止完整运行时", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-collector-app-"));
    temporaryDirectories.push(directory);
    const application = await startApplication({
      DB_PATH: join(directory, "app.sqlite"),
      ONEBOT_HOST: "127.0.0.1",
      ONEBOT_PORT: "0",
      ONEBOT_TOKEN: "x".repeat(32),
      ADMIN_HOST: "127.0.0.1",
      ADMIN_PORT: "0",
      DISCOVERY_PORT: "0",
      ADMIN_TOKEN: "a".repeat(32),
      SENDER_SALT: "s".repeat(16),
      GROUP_WHITELIST: "20001",
      LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      LLM_MODEL: "local-model",
      BACKUP_DIR: join(directory, "backups"),
      BACKUP_INTERVAL_MS: "60000",
      BACKUP_KEEP_COUNT: "2",
      RESERVE_PATH: join(directory, "emergency.reserve"),
      RESERVE_BYTES: "1024",
      MIN_FREE_BYTES: "0",
    });
    await expect(application.stop()).resolves.toBeUndefined();
    await expect(application.stop()).resolves.toBeUndefined();
  });
});

describe("OpenAI 兼容模型适配器", () => {
  it("发送最小消息并校验结构化结果", async () => {
    const fetchImplementation = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              informationType: "发布更新",
              technicalDomains: ["软件开发"],
              evidence: ["发布"],
              needsReview: false,
              reviewIssue: null,
              summary: "发布更新",
            }),
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const analyzer = new OpenAICompatibleAnalyzer({
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "local-model",
      fetchImplementation,
    });
    await expect(analyzer.analyze("发布了新版本")).resolves.toMatchObject({
      informationType: "发布更新",
      needsReview: false,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    if (!request) throw new Error("缺少模型请求参数");
    const body = JSON.parse(String(request.body));
    expect(body.messages[0].content).toContain(
      "版本发布、补丁、功能上线、修复与变更日志归“发布更新”",
    );
    expect(body.messages[0].content).toContain(
      "普通产品发布不得归入",
    );
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        strict: true,
        schema: {
          additionalProperties: false,
          properties: {
            informationType: { enum: expect.arrayContaining(["发布更新", "闲聊"]) },
            evidence: { type: "array" },
          },
        },
      },
    });
  });

  it("把鉴权失败和限流分为不可恢复与可恢复错误", async () => {
    const unauthorized = new OpenAICompatibleAnalyzer({
      baseUrl: "http://localhost/v1",
      model: "x",
      fetchImplementation: async () => new Response("", { status: 401 }),
    });
    await expect(unauthorized.analyze("x")).rejects.toMatchObject({
      code: "invalid_auth",
      retryable: false,
    });

    const limited = new OpenAICompatibleAnalyzer({
      baseUrl: "http://localhost/v1",
      model: "x",
      fetchImplementation: async () => new Response("", {
        status: 429,
        headers: { "retry-after": "2" },
      }),
    });
    await expect(limited.analyze("x")).rejects.toMatchObject({
      code: "rate_limit",
      retryable: true,
      retryAfterMs: 2_000,
    });
  });
});

describe("后台分析循环", () => {
  it("无需控制台操作即可领取并完成持久化任务", async () => {
    const store = openDatabase();
    store.ingest({
      selfId: "1",
      groupId: "2",
      messageId: "3",
      senderHash: "a".repeat(64),
      receivedAt: 100,
      rawSegments: [{ type: "text", data: { text: "更新" } }],
      normalizedText: "更新",
    });
    const worker = new AnalysisWorkerLoop(store, {
      analyze: async () => ({
        informationType: "发布更新",
        technicalDomains: ["软件开发"],
        evidence: ["更新"],
        needsReview: false,
        reviewIssue: null,
        summary: "更新",
      }),
    }, 10);
    worker.start();
    await waitFor(() => store.count("analysis_results") === 1);
    await worker.stop();
    store.close();
  });
});
