import { describe, expect, it } from "vitest";
import { ConnectionHealth } from "../src/health.js";
import { computeBackoffMs, parseRetryAfterMs } from "../src/retry.js";

describe("连接健康", () => {
  it("只根据传输心跳进入 stale，并把 NapCat 与 QQ 状态改为未知", () => {
    const health = new ConnectionHealth(45_000);
    health.connected(1_000);
    health.oneBotHeartbeat(true, true, 2_000);

    expect(health.evaluate(45_999)).toMatchObject({
      transport: "connected",
      napCat: "normal",
      qq: "online",
    });
    expect(health.evaluate(46_000)).toMatchObject({
      transport: "stale",
      napCat: "unknown",
      qq: "unknown",
    });
  });

  it("断开和恢复分别记录状态边界", () => {
    const health = new ConnectionHealth();
    health.connected(100);
    health.disconnected(200);
    expect(health.evaluate(201)).toMatchObject({
      transport: "disconnected",
      disconnectedAt: 200,
    });
    health.connected(300);
    expect(health.evaluate(301)).toMatchObject({
      transport: "connected",
      connectedAt: 300,
      disconnectedAt: null,
    });
  });
});

describe("重试计算", () => {
  it("使用带完全抖动的指数退避并遵守上限", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250 };
    expect(computeBackoffMs(1, policy, () => 0.5)).toBe(50);
    expect(computeBackoffMs(2, policy, () => 0.5)).toBe(100);
    expect(computeBackoffMs(3, policy, () => 0.5)).toBe(125);
  });

  it("解析秒数和 HTTP 日期形式的 Retry-After", () => {
    expect(parseRetryAfterMs("3", 1_000)).toBe(3_000);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfterMs("invalid", 1_000)).toBeNull();
  });
});
