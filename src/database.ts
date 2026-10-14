import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  analysisResultSchema,
  incomingMessageSchema,
  skippedMessageSchema,
  type AnalysisResult,
  type ClaimedJob,
  type IncomingMessage,
  type JobStatus,
  type ReviewAction,
  type SkippedMessage,
} from "./domain.js";
import {
  computeBackoffMs,
  defaultRetryPolicy,
  type RetryPolicy,
} from "./retry.js";

interface JobRow {
  id: number;
  message_id: number;
  status: JobStatus;
  attempt_count: number;
  lease_expires_at: number | null;
  normalized_text?: string;
}

interface ReviewRow {
  id: number;
  message_id: number;
  status: "open" | "resolved" | "dismissed";
  version: number;
  issue_code: string;
}

export interface RuntimeSummary {
  analysisPaused: boolean;
  pauseReason: string | null;
  messageCount: number;
  skippedCount: number;
  queuedCount: number;
  runningCount: number;
  retryWaitCount: number;
  completedCount: number;
  deadLetterCount: number;
  openReviewCount: number;
}

export interface ReviewListItem {
  id: number;
  messageId: number;
  version: number;
  issueCode: string;
  normalizedText: string;
  result: AnalysisResult;
  createdAt: number;
}

export interface DeadLetterListItem {
  id: number;
  messageId: number;
  attemptCount: number;
  errorCode: string | null;
  errorSummary: string | null;
  normalizedText: string;
  updatedAt: number;
}

export interface RetryListItem extends DeadLetterListItem {
  nextAttemptAt: number;
}

export interface InformationListItem {
  id: number;
  groupId: string;
  receivedAt: number;
  normalizedText: string;
  result: AnalysisResult;
}

export interface IngestResult {
  created: boolean;
  messageId: number;
  jobId: number;
}

export interface SkippedIngestResult {
  created: boolean;
  messageId: number;
}

export interface FailureInput {
  retryable: boolean;
  errorCode: string;
  errorSummary: string;
  retryAfterMs?: number;
}

export class CollectorDatabase {
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const currentVersion = Number(this.pragma("user_version"));
    if (currentVersion > 1) {
      throw new Error(`数据库版本 ${currentVersion} 高于当前程序支持的版本 1`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        self_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sender_hash TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        raw_segments_json TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        processing_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (processing_status IN ('pending', 'skipped')),
        current_result_id INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (self_id, group_id, message_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        parent_job_id INTEGER REFERENCES analysis_jobs(id),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'retry_wait', 'completed', 'dead_letter', 'cancelled'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        last_error_code TEXT,
        last_error_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_message
      ON analysis_jobs(message_id)
      WHERE status IN ('queued', 'running', 'retry_wait');

      CREATE TABLE IF NOT EXISTS analysis_attempts (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES analysis_jobs(id),
        attempt_no INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        error_code TEXT,
        error_summary TEXT,
        UNIQUE (job_id, attempt_no)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS analysis_results (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        job_id INTEGER REFERENCES analysis_jobs(id),
        source TEXT NOT NULL CHECK (source IN ('model', 'human')),
        result_json TEXT NOT NULL,
        needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1)),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_items (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
        version INTEGER NOT NULL DEFAULT 1,
        issue_code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_audit_logs (
        id INTEGER PRIMARY KEY,
        review_id INTEGER NOT NULL REFERENCES review_items(id),
        action TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        analysis_paused INTEGER NOT NULL CHECK (analysis_paused IN (0, 1)),
        pause_reason TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO runtime_state (
        id, analysis_paused, pause_reason, updated_at
      ) VALUES (1, 0, NULL, 0);

      CREATE TABLE IF NOT EXISTS connection_events (
        id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'connected', 'stale', 'disconnected', 'recovered'
        )),
        occurred_at INTEGER NOT NULL
      ) STRICT;

      PRAGMA user_version = 1;
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ingest(input: IncomingMessage, now = Date.now()): IngestResult {
    const message = incomingMessageSchema.parse(input);
    return this.transaction(() => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO messages (
          self_id, group_id, message_id, sender_hash, received_at,
          raw_segments_json, normalized_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.selfId,
        message.groupId,
        message.messageId,
        message.senderHash,
        message.receivedAt,
        JSON.stringify(message.rawSegments),
        message.normalizedText,
        now,
      );

      const stored = this.database.prepare(`
        SELECT id FROM messages
        WHERE self_id = ? AND group_id = ? AND message_id = ?
      `).get(message.selfId, message.groupId, message.messageId) as { id: number };

      if (inserted.changes === 1) {
        const job = this.database.prepare(`
          INSERT INTO analysis_jobs (
            message_id, status, attempt_count, next_attempt_at, created_at, updated_at
          ) VALUES (?, 'queued', 0, ?, ?, ?)
        `).run(stored.id, now, now, now);
        return {
          created: true,
          messageId: stored.id,
          jobId: Number(job.lastInsertRowid),
        };
      }

      const existingJob = this.database.prepare(`
        SELECT id FROM analysis_jobs
        WHERE message_id = ?
        ORDER BY id ASC LIMIT 1
      `).get(stored.id) as { id: number };
      return {
        created: false,
        messageId: stored.id,
        jobId: existingJob.id,
      };
    });
  }

  ingestSkipped(input: SkippedMessage, now = Date.now()): SkippedIngestResult {
    const message = skippedMessageSchema.parse(input);
    return this.transaction(() => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO messages (
          self_id, group_id, message_id, sender_hash, received_at,
          raw_segments_json, normalized_text, processing_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'skipped', ?)
      `).run(
        message.selfId,
        message.groupId,
        message.messageId,
        message.senderHash,
        message.receivedAt,
        JSON.stringify(message.rawSegments),
        now,
      );
      const stored = this.database.prepare(`
        SELECT id FROM messages
        WHERE self_id = ? AND group_id = ? AND message_id = ?
      `).get(message.selfId, message.groupId, message.messageId) as { id: number };
      return { created: inserted.changes === 1, messageId: stored.id };
    });
  }

  claimNextJob(now = Date.now(), leaseMs = 60_000): ClaimedJob | null {
    return this.transaction(() => {
      if (this.isAnalysisPaused()) return null;
      const row = this.database.prepare(`
        SELECT j.id, j.message_id, j.status, j.attempt_count,
               j.lease_expires_at, m.normalized_text
        FROM analysis_jobs j
        JOIN messages m ON m.id = j.message_id
        WHERE j.status = 'queued'
           OR (j.status = 'retry_wait' AND j.next_attempt_at <= ?)
           OR (j.status = 'running' AND j.lease_expires_at <= ?)
        ORDER BY j.next_attempt_at ASC, j.id ASC
        LIMIT 1
      `).get(now, now) as JobRow | undefined;
      if (!row) return null;

      const leaseExpiresAt = now + leaseMs;
      const attemptCount = row.attempt_count + 1;
      this.database.prepare(`
        UPDATE analysis_jobs
        SET status = 'running', attempt_count = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(attemptCount, leaseExpiresAt, now, row.id);
      this.database.prepare(`
        INSERT INTO analysis_attempts (job_id, attempt_no, started_at)
        VALUES (?, ?, ?)
      `).run(row.id, attemptCount, now);

      return {
        id: row.id,
        messageId: row.message_id,
        attemptCount,
        leaseExpiresAt,
        normalizedText: row.normalized_text ?? "",
      };
    });
  }

  pauseAnalysisQueue(
    jobId: number,
    errorCode: string,
    errorSummary: string,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const job = this.requireRunningJob(jobId);
      this.database.prepare(`
        UPDATE analysis_jobs
        SET status = 'retry_wait', next_attempt_at = ?, lease_expires_at = NULL,
            last_error_code = ?, last_error_summary = ?, updated_at = ?
        WHERE id = ?
      `).run(now, errorCode, errorSummary, now, jobId);
      this.finishAttempt(
        jobId,
        job.attempt_count,
        "queue_paused",
        now,
        errorCode,
        errorSummary,
      );
      this.database.prepare(`
        UPDATE runtime_state
        SET analysis_paused = 1, pause_reason = ?, updated_at = ?
        WHERE id = 1
      `).run(errorCode, now);
    });
  }

  resumeAnalysisQueue(now = Date.now()): void {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE runtime_state
        SET analysis_paused = 0, pause_reason = NULL, updated_at = ?
        WHERE id = 1
      `).run(now);
      this.database.prepare(`
        UPDATE analysis_jobs
        SET next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
        WHERE status = 'retry_wait' AND last_error_code = 'invalid_auth'
      `).run(now, now);
    });
  }

  isAnalysisPaused(): boolean {
    const row = this.database.prepare(
      "SELECT analysis_paused FROM runtime_state WHERE id = 1",
    ).get() as { analysis_paused: number };
    return row.analysis_paused === 1;
  }

  getRuntimeSummary(): RuntimeSummary {
    const state = this.database.prepare(`
      SELECT analysis_paused, pause_reason FROM runtime_state WHERE id = 1
    `).get() as { analysis_paused: number; pause_reason: string | null };
    const messageCounts = this.database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN processing_status = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM messages
    `).get() as { total: number; skipped: number | null };
    const jobCounts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter
      FROM analysis_jobs
    `).get() as Record<string, number | null>;
    const review = this.database.prepare(`
      SELECT COUNT(*) AS count FROM review_items WHERE status = 'open'
    `).get() as { count: number };
    return {
      analysisPaused: state.analysis_paused === 1,
      pauseReason: state.pause_reason,
      messageCount: messageCounts.total,
      skippedCount: messageCounts.skipped ?? 0,
      queuedCount: jobCounts.queued ?? 0,
      runningCount: jobCounts.running ?? 0,
      retryWaitCount: jobCounts.retry_wait ?? 0,
      completedCount: jobCounts.completed ?? 0,
      deadLetterCount: jobCounts.dead_letter ?? 0,
      openReviewCount: review.count,
    };
  }

  listOpenReviews(limit = 100): ReviewListItem[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT r.id, r.message_id, r.version, r.issue_code, r.created_at,
             m.normalized_text, a.result_json
      FROM review_items r
      JOIN messages m ON m.id = r.message_id
      JOIN analysis_results a ON a.id = m.current_result_id
      WHERE r.status = 'open'
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT ?
    `).all(safeLimit) as Array<{
      id: number; message_id: number; version: number; issue_code: string;
      created_at: number; normalized_text: string; result_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      version: row.version,
      issueCode: row.issue_code,
      normalizedText: row.normalized_text,
      result: analysisResultSchema.parse(JSON.parse(row.result_json)),
      createdAt: row.created_at,
    }));
  }

  listInformation(limit = 100): InformationListItem[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT m.id, m.group_id, m.received_at, m.normalized_text, a.result_json
      FROM messages m
      JOIN analysis_results a ON a.id = m.current_result_id
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT ?
    `).all(safeLimit) as Array<{
      id: number; group_id: string; received_at: number;
      normalized_text: string; result_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      receivedAt: row.received_at,
      normalizedText: row.normalized_text,
      result: analysisResultSchema.parse(JSON.parse(row.result_json)),
    }));
  }

  listDeadLetters(limit = 100): DeadLetterListItem[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT j.id, j.message_id, j.attempt_count, j.last_error_code,
             j.last_error_summary, j.updated_at, m.normalized_text
      FROM analysis_jobs j
      JOIN messages m ON m.id = j.message_id
      WHERE j.status = 'dead_letter'
        AND NOT EXISTS (
          SELECT 1 FROM analysis_jobs child WHERE child.parent_job_id = j.id
        )
      ORDER BY j.updated_at DESC, j.id DESC
      LIMIT ?
    `).all(safeLimit) as Array<{
      id: number; message_id: number; attempt_count: number;
      last_error_code: string | null; last_error_summary: string | null;
      updated_at: number; normalized_text: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      attemptCount: row.attempt_count,
      errorCode: row.last_error_code,
      errorSummary: row.last_error_summary,
      normalizedText: row.normalized_text,
      updatedAt: row.updated_at,
    }));
  }

  listWaitingRetries(limit = 100): RetryListItem[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT j.id, j.message_id, j.attempt_count, j.last_error_code,
             j.last_error_summary, j.updated_at, j.next_attempt_at,
             m.normalized_text
      FROM analysis_jobs j
      JOIN messages m ON m.id = j.message_id
      WHERE j.status = 'retry_wait'
      ORDER BY j.next_attempt_at ASC, j.id ASC
      LIMIT ?
    `).all(safeLimit) as Array<{
      id: number; message_id: number; attempt_count: number;
      last_error_code: string | null; last_error_summary: string | null;
      updated_at: number; next_attempt_at: number; normalized_text: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      attemptCount: row.attempt_count,
      errorCode: row.last_error_code,
      errorSummary: row.last_error_summary,
      normalizedText: row.normalized_text,
      updatedAt: row.updated_at,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  retryJobNow(jobId: number, now = Date.now()): void {
    const updated = this.database.prepare(`
      UPDATE analysis_jobs
      SET next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'retry_wait'
    `).run(now, now, jobId);
    if (updated.changes !== 1) throw new Error("只有等待重试的任务可以提前重试");
  }

  exportCsv(): string {
    const rows = this.database.prepare(`
      SELECT m.id, m.group_id, m.received_at, m.normalized_text,
             m.processing_status, a.result_json
      FROM messages m
      LEFT JOIN analysis_results a ON a.id = m.current_result_id
      ORDER BY m.received_at ASC, m.id ASC
    `).all() as Array<{
      id: number; group_id: string; received_at: number; normalized_text: string;
      processing_status: string; result_json: string | null;
    }>;
    const header = [
      "id", "group_id", "received_at", "message", "status", "information_type",
      "technical_domains", "location", "source", "product", "version",
      "event_time", "summary", "needs_review", "review_issue",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) {
      const result = row.result_json
        ? analysisResultSchema.parse(JSON.parse(row.result_json))
        : null;
      lines.push([
        row.id,
        row.group_id,
        new Date(row.received_at).toISOString(),
        row.normalized_text,
        result ? "analyzed" : row.processing_status,
        result?.informationType ?? "",
        result?.technicalDomains.join("|") ?? "",
        result?.location ?? "",
        result?.source ?? "",
        result?.product ?? "",
        result?.version ?? "",
        result?.eventTime ?? "",
        result?.summary ?? "",
        result?.needsReview ?? "",
        result?.reviewIssue ?? "",
      ].map(csvCell).join(","));
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  recordConnectionEvent(
    eventType: "connected" | "stale" | "disconnected" | "recovered",
    now = Date.now(),
  ): void {
    this.database.prepare(`
      INSERT INTO connection_events (event_type, occurred_at) VALUES (?, ?)
    `).run(eventType, now);
  }

  async backupTo(path: string): Promise<void> {
    await backup(this.database, path);
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      const row = snapshot.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (row.integrity_check !== "ok") {
        throw new Error(`备份完整性检查失败：${row.integrity_check}`);
      }
    } finally {
      snapshot.close();
    }
  }

  completeJob(
    jobId: number,
    rawResult: AnalysisResult,
    now = Date.now(),
  ): number {
    const result = analysisResultSchema.parse(rawResult);
    return this.transaction(() => {
      const job = this.requireRunningJob(jobId);
      const inserted = this.database.prepare(`
        INSERT INTO analysis_results (
          message_id, job_id, source, result_json, needs_review, created_at
        ) VALUES (?, ?, 'model', ?, ?, ?)
      `).run(
        job.message_id,
        jobId,
        JSON.stringify(result),
        result.needsReview ? 1 : 0,
        now,
      );
      const resultId = Number(inserted.lastInsertRowid);

      this.database.prepare(
        "UPDATE messages SET current_result_id = ? WHERE id = ?",
      ).run(resultId, job.message_id);
      this.database.prepare(`
        UPDATE analysis_jobs
        SET status = 'completed', lease_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, jobId);
      this.finishAttempt(jobId, job.attempt_count, "completed", now);

      if (result.needsReview) {
        this.database.prepare(`
          INSERT INTO review_items (
            message_id, status, version, issue_code, created_at
          ) VALUES (?, 'open', 1, ?, ?)
        `).run(job.message_id, result.reviewIssue ?? "unknown", now);
      }
      return resultId;
    });
  }

  failJob(
    jobId: number,
    failure: FailureInput,
    options: {
      now?: number;
      policy?: RetryPolicy;
      random?: () => number;
    } = {},
  ): JobStatus {
    const now = options.now ?? Date.now();
    const policy = options.policy ?? defaultRetryPolicy;
    return this.transaction(() => {
      const job = this.requireRunningJob(jobId);
      const willRetry = failure.retryable && job.attempt_count < policy.maxAttempts;
      const status: JobStatus = willRetry ? "retry_wait" : "dead_letter";
      const delay = failure.retryAfterMs ?? computeBackoffMs(
        job.attempt_count,
        policy,
        options.random,
      );
      const nextAttemptAt = willRetry ? now + delay : now;

      this.database.prepare(`
        UPDATE analysis_jobs
        SET status = ?, next_attempt_at = ?, lease_expires_at = NULL,
            last_error_code = ?, last_error_summary = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status,
        nextAttemptAt,
        failure.errorCode,
        failure.errorSummary,
        now,
        jobId,
      );
      this.finishAttempt(
        jobId,
        job.attempt_count,
        status,
        now,
        failure.errorCode,
        failure.errorSummary,
      );
      return status;
    });
  }

  requeueDeadLetter(jobId: number, now = Date.now()): number {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || job.status !== "dead_letter") {
        throw new Error("只有死信任务可以重新入队");
      }
      const existingChild = this.database.prepare(`
        SELECT id FROM analysis_jobs WHERE parent_job_id = ? LIMIT 1
      `).get(jobId);
      if (existingChild) throw new Error("该死信任务已经重新入队");
      const inserted = this.database.prepare(`
        INSERT INTO analysis_jobs (
          message_id, parent_job_id, status, attempt_count,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 'queued', 0, ?, ?, ?)
      `).run(job.message_id, jobId, now, now, now);
      return Number(inserted.lastInsertRowid);
    });
  }

  resolveReview(
    reviewId: number,
    expectedVersion: number,
    action: ReviewAction,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const review = this.database.prepare(
        "SELECT * FROM review_items WHERE id = ?",
      ).get(reviewId) as ReviewRow | undefined;
      if (!review || review.status !== "open") {
        throw new Error("审核项不存在或已经处理");
      }
      if (review.version !== expectedVersion) {
        throw new Error("审核项版本冲突");
      }

      let resultId: number | null = null;
      let nextStatus: "resolved" | "dismissed" = "resolved";
      if (action.type === "correct") {
        const result = analysisResultSchema.parse({
          ...action.result,
          needsReview: false,
          reviewIssue: null,
        });
        const inserted = this.database.prepare(`
          INSERT INTO analysis_results (
            message_id, job_id, source, result_json, needs_review, created_at
          ) VALUES (?, NULL, 'human', ?, 0, ?)
        `).run(review.message_id, JSON.stringify(result), now);
        resultId = Number(inserted.lastInsertRowid);
        this.database.prepare(
          "UPDATE messages SET current_result_id = ? WHERE id = ?",
        ).run(resultId, review.message_id);
      } else if (action.type === "dismiss") {
        nextStatus = "dismissed";
      }

      const updated = this.database.prepare(`
        UPDATE review_items
        SET status = ?, version = version + 1, resolved_at = ?
        WHERE id = ? AND status = 'open' AND version = ?
      `).run(nextStatus, now, reviewId, expectedVersion);
      if (updated.changes !== 1) throw new Error("审核项版本冲突");

      this.database.prepare(`
        INSERT INTO review_audit_logs (
          review_id, action, before_json, after_json, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        reviewId,
        action.type,
        JSON.stringify(review),
        JSON.stringify({ status: nextStatus, version: expectedVersion + 1, resultId }),
        action.note ?? null,
        now,
      );
    });
  }

  getJob(jobId: number): JobRow | undefined {
    return this.database.prepare(
      "SELECT * FROM analysis_jobs WHERE id = ?",
    ).get(jobId) as JobRow | undefined;
  }

  getOpenReview(messageId: number): ReviewRow | undefined {
    return this.database.prepare(`
      SELECT * FROM review_items WHERE message_id = ? AND status = 'open'
    `).get(messageId) as ReviewRow | undefined;
  }

  count(table: "messages" | "analysis_jobs" | "analysis_results" | "review_audit_logs" | "connection_events"): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  pragma(name: "journal_mode" | "synchronous" | "foreign_keys" | "user_version"): SQLInputValue {
    const row = this.database.prepare(`PRAGMA ${name}`).get() as Record<
      string,
      SQLInputValue
    >;
    return Object.values(row)[0] ?? null;
  }

  private requireRunningJob(jobId: number): JobRow {
    const job = this.getJob(jobId);
    if (!job || job.status !== "running") {
      throw new Error("任务不存在或未被当前工作线程领取");
    }
    return job;
  }

  private finishAttempt(
    jobId: number,
    attemptNo: number,
    outcome: string,
    endedAt: number,
    errorCode: string | null = null,
    errorSummary: string | null = null,
  ): void {
    this.database.prepare(`
      UPDATE analysis_attempts
      SET ended_at = ?, outcome = ?, error_code = ?, error_summary = ?
      WHERE job_id = ? AND attempt_no = ?
    `).run(endedAt, outcome, errorCode, errorSummary, jobId, attemptNo);
  }
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
