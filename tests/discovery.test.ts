import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_QUERY,
  DISCOVERY_RESPONSE,
  LocalDiscoveryService,
} from "../src/discovery.js";

describe("局域网工作台发现", () => {
  it("回复当前管理端口并忽略无关数据包", async () => {
    const service = new LocalDiscoveryService(0, 4321);
    const port = await service.start();
    const client = createSocket("udp4");
    try {
      client.send("unrelated", port, "127.0.0.1");
      client.send(DISCOVERY_QUERY, port, "127.0.0.1");
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("发现服务响应超时")), 1_000);
        client.once("message", (message) => {
          clearTimeout(timer);
          resolve(message.toString("utf8"));
        });
      });
      expect(response).toBe(`${DISCOVERY_RESPONSE}:4321`);
    } finally {
      client.close();
      await service.stop();
    }
  });
});
