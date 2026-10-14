import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminServer, type AdminServerOptions } from "../src/admin.js";
import { CollectorDatabase } from "../src/database.js";
import type { AnalysisResult } from "../src/domain.js";
import { ConnectionHealth } from "../src/health.js";

const directories: string[] = [];
const servers: AdminServer[] = [];
const token = "admin-token-".padEnd(32, "x");

function result(needsReview = false): AnalysisResult {
  return {
    informationType: "发布更新",
    technicalDomains: ["软件开发"],
    evidence: ["发布"],
    location: null,
    source: null,
    product: null,
    version: null,
    eventTime: null,
    needsReview,
    reviewIssue: needsReview ? "来源待确认" : null,
    summary: "发布更新",
  };
}

function openStore(): CollectorDatabase {
  const directory = mkdtempSync(join(tmpdir(), "qq-admin-"));
  directories.push(directory);
  return new CollectorDatabase(join(directory, "collector.sqlite"));
}

async function start(
  store: CollectorDatabase,
  health = new ConnectionHealth(),
  settings: Partial<Pick<AdminServerOptions,
    "getModelConfig" | "updateModelConfig" | "getGroupWhitelist" | "updateGroupWhitelist"
  >> = {},
) {
  const server = new AdminServer({ port: 0, token, store, health, ...settings });
  servers.push(server);
  const port = await server.start();
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("本机管理工作台", () => {
  it("可监听局域网地址供手机使用", async () => {
    const store = openStore();
    const server = new AdminServer({
      host: "0.0.0.0",
      port: 0,
      token,
      store,
      health: new ConnectionHealth(),
    });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}`);
    expect(response.status).toBe(200);
    store.close();
  });

  it("页面可打开，但所有业务数据接口都需要独立管理令牌", async () => {
    const store = openStore();
    const base = await start(store);
    const page = await fetch(base);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("草木知讯 · 本机无人值守采集与分析");
    expect(html).toContain('src="/assets/nahida-avatar.png"');
    expect(html).toContain('data-tab="reviews"');
    expect(html).toContain("grid-template-columns:repeat(2,1fr)");
    expect(html).toContain("el('details'");
    expect(html).toContain("重点信息");
    expect(html).toContain("其他分类");
    expect(html).toContain('data-tab="groups"');
    expect(html).toContain("在此电脑记住管理令牌");
    expect(html).toContain("localStorage.getItem('adminToken')");
    expect(html).toContain("value.trim()");

    const missing = await fetch(`${base}/api/status`);
    expect(missing.status).toBe(401);
    const authorized = await fetch(`${base}/api/status`, {
      headers: { "x-admin-token": token },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      queues: { messageCount: 0, openReviewCount: 0 },
      health: { transport: "connecting" },
    });
    const exported = await fetch(`${base}/api/export.csv`, {
      headers: { "x-admin-token": token },
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect(await exported.text()).toContain("information_type");
    const mascot = await fetch(`${base}/assets/nahida-avatar.png`);
    expect(mascot.status).toBe(200);
    expect(mascot.headers.get("content-type")).toBe("image/png");
    store.close();
  });

  it("通过接口完成待审核确认并保留审计记录", async () => {
    const store = openStore();
    const { jobId } = store.ingest({
      selfId: "1", groupId: "2", messageId: "3", senderHash: "a".repeat(64),
      receivedAt: 100, rawSegments: [], normalizedText: "Node 发布更新",
    }, 100);
    const claimed = store.claimNextJob(100)!;
    store.completeJob(claimed.id, result(true), 101);
    const review = store.listOpenReviews()[0]!;
    const base = await start(store);
    const response = await fetch(`${base}/api/reviews/${review.id}`, {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: JSON.stringify({ type: "accept", version: review.version }),
    });
    expect(response.status).toBe(200);
    expect(store.listOpenReviews()).toHaveLength(0);
    expect(store.count("review_audit_logs")).toBe(1);
    expect(store.getJob(jobId)?.status).toBe("completed");
    store.close();
  });

  it("通过接口列出已分类信息", async () => {
    const store = openStore();
    const { jobId } = store.ingest({
      selfId: "1", groupId: "2", messageId: "info", senderHash: "d".repeat(64),
      receivedAt: 100, rawSegments: [], normalizedText: "Node 发布更新",
    }, 100);
    store.claimNextJob(100);
    store.completeJob(jobId, result(false), 101);
    const base = await start(store);

    const response = await fetch(`${base}/api/information`, {
      headers: { "x-admin-token": token },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ groupId: "2", normalizedText: "Node 发布更新", result: { informationType: "发布更新" } }],
    });
    store.close();
  });

  it("恢复暂停队列，并只允许未重新入队的死信再次入队", async () => {
    const store = openStore();
    const { jobId } = store.ingest({
      selfId: "1", groupId: "2", messageId: "4", senderHash: "b".repeat(64),
      receivedAt: 100, rawSegments: [], normalizedText: "失败任务",
    }, 100);
    store.claimNextJob(100);
    store.pauseAnalysisQueue(jobId, "invalid_auth", "凭证无效", 101);
    store.resumeAnalysisQueue(102);
    store.claimNextJob(102);
    store.failJob(jobId, { retryable: false, errorCode: "invalid", errorSummary: "无效请求" }, { now: 103 });
    const base = await start(store);
    const first = await fetch(`${base}/api/dead-letters/${jobId}/requeue`, {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(200);
    expect(store.listDeadLetters()).toHaveLength(0);
    const second = await fetch(`${base}/api/dead-letters/${jobId}/requeue`, {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(second.status).toBe(400);
    store.close();
  });

  it("拒绝非 JSON 写操作和过期的审核版本", async () => {
    const store = openStore();
    const base = await start(store);
    const wrongType = await fetch(`${base}/api/analysis/resume`, {
      method: "POST",
      headers: { "x-admin-token": token },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toMatchObject({ error: expect.stringContaining("application/json") });
    store.close();
  });

  it("列出等待重试任务并允许立即重试", async () => {
    const store = openStore();
    const { jobId } = store.ingest({
      selfId: "1", groupId: "2", messageId: "5", senderHash: "c".repeat(64),
      receivedAt: 100, rawSegments: [], normalizedText: "等待重试",
    }, 100);
    store.claimNextJob(100);
    store.failJob(
      jobId,
      { retryable: true, errorCode: "timeout", errorSummary: "超时" },
      { now: 101, random: () => 0.9 },
    );
    const base = await start(store);
    const listed = await fetch(`${base}/api/retries`, {
      headers: { "x-admin-token": token },
    });
    expect(await listed.json()).toMatchObject({ items: [{ id: jobId }] });
    const retried = await fetch(`${base}/api/retries/${jobId}/now`, {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(retried.status).toBe(200);
    expect(store.claimNextJob()?.id).toBe(jobId);
    store.close();
  });

  it("每台安装实例可设置自己的模型密钥，但接口不回传密钥", async () => {
    const store = openStore();
    let saved: unknown;
    const base = await start(store, new ConnectionHealth(), {
      getModelConfig: () => ({
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "local-model",
        hasApiKey: true,
      }),
      updateModelConfig: (values) => { saved = values; },
    });
    const current = await fetch(`${base}/api/model-config`, {
      headers: { "x-admin-token": token },
    });
    const currentBody = await current.json();
    expect(currentBody).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
      hasApiKey: true,
    });
    expect(JSON.stringify(currentBody)).not.toContain("secret");

    const updated = await fetch(`${base}/api/model-config`, {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://user.example/v1",
        model: "user-model",
        apiKey: "user-secret",
      }),
    });
    expect(updated.status).toBe(200);
    expect(saved).toEqual({
      baseUrl: "https://user.example/v1",
      model: "user-model",
      apiKey: "user-secret",
    });
    store.close();
  });

  it("通过控制台查看并更新多个采集群", async () => {
    const store = openStore();
    let groups = ["100"];
    const base = await start(store, new ConnectionHealth(), {
      getGroupWhitelist: () => groups,
      updateGroupWhitelist: (next) => { groups = next; },
    });
    const headers = { "x-admin-token": token };
    const current = await fetch(`${base}/api/group-whitelist`, { headers });
    expect(await current.json()).toEqual({ groups: ["100"] });

    const updated = await fetch(`${base}/api/group-whitelist`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ groups: ["100", "200", "200"] }),
    });
    expect(updated.status).toBe(200);
    expect(groups).toEqual(["100", "200"]);

    const invalid = await fetch(`${base}/api/group-whitelist`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ groups: ["not-a-group"] }),
    });
    expect(invalid.status).toBe(400);
    store.close();
  });
});
