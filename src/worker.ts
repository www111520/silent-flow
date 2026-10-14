import { ZodError } from "zod";
import { CollectorDatabase } from "./database.js";
import { analysisResultSchema, type AnalysisResult } from "./domain.js";
import { defaultRetryPolicy, type RetryPolicy } from "./retry.js";

export interface Analyzer {
  analyze(text: string): Promise<unknown>;
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface WorkerOptions {
  now?: () => number;
  random?: () => number;
  leaseMs?: number;
  retryPolicy?: RetryPolicy;
}

export async function runOneJob(
  store: CollectorDatabase,
  analyzer: Analyzer,
  options: WorkerOptions = {},
): Promise<"idle" | "completed" | "retry_wait" | "dead_letter" | "paused"> {
  const now = options.now ?? Date.now;
  const job = store.claimNextJob(now(), options.leaseMs ?? 60_000);
  if (!job) return "idle";

  try {
    const raw = await analyzer.analyze(job.normalizedText);
    const result: AnalysisResult = analysisResultSchema.parse(raw);
    store.completeJob(job.id, result, now());
    return "completed";
  } catch (error) {
    const failure = classifyAnalysisError(error);
    if (failure.errorCode === "invalid_auth") {
      store.pauseAnalysisQueue(
        job.id,
        failure.errorCode,
        failure.errorSummary,
        now(),
      );
      return "paused";
    }
    return store.failJob(
      job.id,
      failure,
      {
        now: now(),
        policy: options.retryPolicy ?? defaultRetryPolicy,
        ...(options.random === undefined ? {} : { random: options.random }),
      },
    ) as "retry_wait" | "dead_letter";
  }
}

export function classifyAnalysisError(error: unknown): {
  retryable: boolean;
  errorCode: string;
  errorSummary: string;
  retryAfterMs?: number;
} {
  if (error instanceof AnalysisError) {
    return {
      retryable: error.retryable,
      errorCode: error.code,
      errorSummary: error.message,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
    };
  }
  if (error instanceof ZodError) {
    return {
      retryable: true,
      errorCode: "invalid_model_output",
      errorSummary: error.issues.map((issue) => issue.message).join("; "),
    };
  }
  return {
    retryable: true,
    errorCode: "unexpected_error",
    errorSummary: error instanceof Error ? error.message : "未知分析错误",
  };
}
