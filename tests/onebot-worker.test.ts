import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorDatabase } from "../src/database.js";
import { createOneBotEventHandler, normalizeSegments } from "../src/onebot.js";
import { AnalysisError, runOneJob } from "../src/worker.js";

const temporaryDirectories: string[] = [];

function openDatabase(): CollectorDatabase {
  const directory = mkdtempSync(join(tmpdir(), "qq-collector-"));
  temporaryDirectories.push(directory);
  return new CollectorDatabase(join(directory, "collector.sqlite"));
}

function groupEvent(overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 10001,
    group_id: 20001,
    message_id: 30001,
    user_id: 40001,
    time: 1_700_000_000,
    message: [{ type: "text", data: { text: "发现新的安全更新" } }],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OneBot 事件处理", () => {
  it("只接收白名单群的文本，并对发送者标识做不可逆哈希", () => {
    const store = openDatabase();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(["20001"]),
      senderSalt: "test-only-salt",
    });

    const handled = handler(groupEvent());
    expect(handled.type).toBe("message");
    const row = store.database.prepare(
      "SELECT sender_hash, normalized_text FROM messages",
    ).get() as { sender_hash: string; normalized_text: string };
    expect(row.sender_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.sender_hash).not.toContain("40001");
    expect(row.normalized_text).toBe("发现新的安全更新");

    expect(handler(groupEvent({ group_id: 99999 }))).toEqual({
      type: "ignored",
      reason: "group_not_allowed",
    });
    expect(store.count("messages")).toBe(1);
    store.close();
  });

  it("运行中更新白名单后立即接收新群消息", () => {
    const store = openDatabase();
    const groupWhitelist = new Set(["20001"]);
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist,
      senderSalt: "test-only-salt",
    });

    expect(handler(groupEvent({ group_id: 99999 })).type).toBe("ignored");
    groupWhitelist.add("99999");
    expect(handler(groupEvent({ group_id: 99999 })).type).toBe("message");
    store.close();
  });

  it("保存纯非文本消息为 skipped 且不创建任务，并规范化回复与 @ 信息", () => {
    const store = openDatabase();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(["20001"]),
      senderSalt: "test-only-salt",
    });
    expect(
      handler(groupEvent({ message: [{ type: "image", data: { file: "x" } }] })),
    ).toMatchObject({ type: "skipped", reason: "no_text" });
    expect(store.count("messages")).toBe(1);
    expect(store.count("analysis_jobs")).toBe(0);
    expect(
      (store.database.prepare("SELECT processing_status FROM messages").get() as {
        processing_status: string;
      }).processing_status,
    ).toBe("skipped");
    expect(
      normalizeSegments([
        { type: "reply", data: { id: 88 } },
        { type: "at", data: { qq: 123 } },
        { type: "text", data: { text: "  请看更新  " } },
      ]),
    ).toBe("[回复:88] @用户 请看更新");
    store.close();
  });

  it("分别传递 NapCat 与 QQ 心跳状态", () => {
    const store = openDatabase();
    const onHeartbeat = vi.fn();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(),
      senderSalt: "test-only-salt",
      onHeartbeat,
    });
    expect(
      handler({
        post_type: "meta_event",
        meta_event_type: "heartbeat",
        status: { good: false, online: true },
      }),
    ).toEqual({ type: "heartbeat", good: false, online: true });
    expect(onHeartbeat).toHaveBeenCalledWith(false, true);
    store.close();
  });
});

describe("分析工作线程", () => {
  it("完成有效结果并为不确定结果建立审核项", async () => {
    const store = openDatabase();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(["20001"]),
      senderSalt: "test-only-salt",
    });
    const handled = handler(groupEvent());
    expect(handled.type).toBe("message");

    const state = await runOneJob(store, {
      analyze: async () => ({
        informationType: "安全预警",
        technicalDomains: ["网络安全"],
        evidence: ["安全更新"],
        needsReview: true,
        reviewIssue: "来源尚未核实",
        summary: "发现安全更新",
      }),
    });
    expect(state).toBe("completed");
    expect(store.count("analysis_results")).toBe(1);
    expect(
      store.getOpenReview(
        handled.type === "message" ? handled.ingest.messageId : -1,
      ),
    ).toBeDefined();
    store.close();
  });

  it("把临时错误持久化为等待重试，把确定错误送入死信", async () => {
    const store = openDatabase();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(["20001"]),
      senderSalt: "test-only-salt",
    });
    handler(groupEvent());

    expect(
      await runOneJob(
        store,
        { analyze: async () => { throw new AnalysisError("限流", "rate_limit", true, 500); } },
        { now: () => 1_000, random: () => 0 },
      ),
    ).toBe("retry_wait");
    expect(
      await runOneJob(
        store,
        { analyze: async () => { throw new AnalysisError("不支持", "unsupported", false); } },
        { now: () => 1_500, random: () => 0 },
      ),
    ).toBe("dead_letter");
    store.close();
  });

  it("鉴权失败暂停整个队列，修复配置后从原任务继续", async () => {
    const store = openDatabase();
    const handler = createOneBotEventHandler({
      store,
      groupWhitelist: new Set(["20001"]),
      senderSalt: "test-only-salt",
    });
    handler(groupEvent());

    expect(
      await runOneJob(
        store,
        { analyze: async () => { throw new AnalysisError("密钥失效", "invalid_auth", false); } },
        { now: () => 1_000 },
      ),
    ).toBe("paused");
    expect(store.isAnalysisPaused()).toBe(true);
    expect(store.claimNextJob(2_000)).toBeNull();

    store.resumeAnalysisQueue(2_001);
    expect(store.isAnalysisPaused()).toBe(false);
    expect(store.claimNextJob(2_001)?.attemptCount).toBe(2);
    store.close();
  });
});
