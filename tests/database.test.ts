import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorDatabase } from "../src/database.js";
import type { AnalysisResult, IncomingMessage } from "../src/domain.js";

const temporaryDirectories: string[] = [];

function openDatabase(): CollectorDatabase {
  const directory = mkdtempSync(join(tmpdir(), "qq-collector-"));
  temporaryDirectories.push(directory);
  return new CollectorDatabase(join(directory, "collector.sqlite"));
}

function message(messageId = "m-1"): IncomingMessage {
  return {
    selfId: "10001",
    groupId: "20001",
    messageId,
    senderHash: "a".repeat(64),
    receivedAt: 1_700_000_000_000,
    rawSegments: [{ type: "text", data: { text: "Node 发布新版本" } }],
    normalizedText: "Node 发布新版本",
  };
}

function result(needsReview = false): AnalysisResult {
  return {
    informationType: "发布更新",
    technicalDomains: ["软件开发"],
    evidence: ["发布新版本"],
    location: null,
    source: "Node.js 官网",
    product: "Node.js",
    version: "24",
    eventTime: null,
    needsReview,
    reviewIssue: needsReview ? "版本信息不足" : null,
    summary: "Node 发布新版本",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CollectorDatabase", () => {
  it("启用 WAL、FULL 同步和外键", () => {
    const store = openDatabase();
    expect(String(store.pragma("journal_mode")).toLowerCase()).toBe("wal");
    expect(Number(store.pragma("synchronous"))).toBe(2);
    expect(Number(store.pragma("foreign_keys"))).toBe(1);
    expect(Number(store.pragma("user_version"))).toBe(1);
    store.close();
  });

  it("创建可通过完整性检查并保留消息的在线备份", async () => {
    const store = openDatabase();
    store.ingest(message(), 100);
    const directory = temporaryDirectories.at(-1)!;
    const backupPath = join(directory, "backup.sqlite");
    await store.backupTo(backupPath);

    const snapshot = new CollectorDatabase(backupPath);
    expect(snapshot.count("messages")).toBe(1);
    expect(snapshot.count("analysis_jobs")).toBe(1);
    snapshot.close();
    store.close();
  });

  it("在同一事务中创建消息和唯一任务，并对重复事件去重", () => {
    const store = openDatabase();
    const first = store.ingest(message(), 100);
    const duplicate = store.ingest(message(), 101);

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ ...first, created: false });
    expect(store.count("messages")).toBe(1);
    expect(store.count("analysis_jobs")).toBe(1);
    store.close();
  });

  it("任务创建失败时回滚消息写入", () => {
    const store = openDatabase();
    store.database.exec(`
      CREATE TRIGGER reject_job BEFORE INSERT ON analysis_jobs
      BEGIN SELECT RAISE(ABORT, 'simulated job failure'); END
    `);

    expect(() => store.ingest(message(), 100)).toThrow("simulated job failure");
    expect(store.count("messages")).toBe(0);
    expect(store.count("analysis_jobs")).toBe(0);
    store.close();
  });

  it("租约到期后重新领取任务并保留尝试次数", () => {
    const store = openDatabase();
    const { jobId } = store.ingest(message(), 100);

    expect(store.claimNextJob(100, 50)?.attemptCount).toBe(1);
    expect(store.claimNextJob(149, 50)).toBeNull();
    const recovered = store.claimNextJob(150, 50);
    expect(recovered?.id).toBe(jobId);
    expect(recovered?.attemptCount).toBe(2);
    store.close();
  });

  it("按上限重试，达到上限进入死信并允许创建新任务", () => {
    const store = openDatabase();
    const { jobId } = store.ingest(message(), 100);
    store.claimNextJob(100, 50);

    const retry = store.failJob(
      jobId,
      { retryable: true, errorCode: "timeout", errorSummary: "模型超时" },
      {
        now: 100,
        random: () => 0.5,
        policy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 },
      },
    );
    expect(retry).toBe("retry_wait");
    expect(store.claimNextJob(104, 50)).toBeNull();
    expect(store.claimNextJob(105, 50)?.attemptCount).toBe(2);

    const dead = store.failJob(
      jobId,
      { retryable: true, errorCode: "timeout", errorSummary: "仍然超时" },
      {
        now: 106,
        random: () => 0,
        policy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 },
      },
    );
    expect(dead).toBe("dead_letter");
    const replacementId = store.requeueDeadLetter(jobId, 107);
    expect(replacementId).not.toBe(jobId);
    expect(store.getJob(jobId)?.status).toBe("dead_letter");
    expect(store.getJob(replacementId)?.status).toBe("queued");
    store.close();
  });

  it("完成任务后仅为不确定结果创建审核项，并用版本锁处理修正", () => {
    const store = openDatabase();
    const { jobId, messageId } = store.ingest(message(), 100);
    store.claimNextJob(100, 50);
    store.completeJob(jobId, result(true), 101);

    expect(store.getJob(jobId)?.status).toBe("completed");
    const review = store.getOpenReview(messageId);
    expect(review?.version).toBe(1);

    store.resolveReview(
      review!.id,
      1,
      { type: "correct", result: result(false), note: "人工核对版本" },
      102,
    );
    expect(store.getOpenReview(messageId)).toBeUndefined();
    expect(store.count("analysis_results")).toBe(2);
    expect(store.count("review_audit_logs")).toBe(1);
    expect(() =>
      store.resolveReview(review!.id, 1, { type: "accept" }, 103),
    ).toThrow("已经处理");
    store.close();
  });

  it("按接收时间倒序列出已分类信息", () => {
    const store = openDatabase();
    for (const [id, receivedAt] of [["old", 100], ["new", 200]] as const) {
      const { jobId } = store.ingest({ ...message(id), receivedAt }, receivedAt);
      store.claimNextJob(receivedAt);
      store.completeJob(jobId, result(false), receivedAt);
    }

    expect(store.listInformation()).toMatchObject([
      { receivedAt: 200, normalizedText: "Node 发布新版本", result: { product: "Node.js" } },
      { receivedAt: 100 },
    ]);
    store.close();
  });

  it("信息流保留重要和普通分类", () => {
    const store = openDatabase();
    for (const [id, informationType] of [["release", "发布更新"], ["chat", "闲聊"]] as const) {
      const { jobId } = store.ingest(message(id), 100);
      store.claimNextJob(100);
      store.completeJob(jobId, { ...result(false), informationType }, 101);
    }

    expect(store.listInformation().map((item) => item.result.informationType).sort()).toEqual([
      "发布更新",
      "闲聊",
    ]);
    store.close();
  });

  it("导出包含完整提取字段的 CSV，并防止电子表格公式注入", () => {
    const store = openDatabase();
    const { jobId } = store.ingest({ ...message(), normalizedText: "=危险公式" }, 100);
    store.claimNextJob(100, 50);
    store.completeJob(jobId, result(false), 101);

    const csv = store.exportCsv();
    expect(csv).toContain("information_type");
    expect(csv).toContain('"Node.js 官网"');
    expect(csv).toContain('"24"');
    expect(csv).toContain('"\'=危险公式"');
    store.close();
  });

  it("只允许等待重试的任务提前重试", () => {
    const store = openDatabase();
    const { jobId } = store.ingest(message(), 100);
    store.claimNextJob(100, 50);
    store.failJob(
      jobId,
      { retryable: true, errorCode: "timeout", errorSummary: "超时" },
      { now: 101, random: () => 0.9 },
    );
    expect(store.listWaitingRetries()[0]?.nextAttemptAt).toBeGreaterThan(101);
    store.retryJobNow(jobId, 102);
    expect(store.claimNextJob(102)?.id).toBe(jobId);
    expect(() => store.retryJobNow(jobId, 103)).toThrow("只有等待重试");
    store.close();
  });
});
