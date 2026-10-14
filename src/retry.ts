export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
};

export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = defaultRetryPolicy,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt 必须是大于等于 1 的整数");
  }

  const ceiling = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (attempt - 1),
  );
  return Math.floor(Math.max(0, Math.min(0.999999999, random())) * ceiling);
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - now);
}
