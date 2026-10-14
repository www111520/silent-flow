import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { ConnectionHealth } from "./health.js";
import type { ParsedOneBotEvent } from "./onebot.js";

export interface OneBotServerOptions {
  host?: "127.0.0.1" | "::1" | "localhost";
  port: number;
  token: string;
  health: ConnectionHealth;
  handleEvent: (event: unknown) => ParsedOneBotEvent;
  pingIntervalMs?: number;
  onInvalidPayload?: (error: Error) => void;
  onConnectionEvent?: (
    type: "connected" | "stale" | "disconnected" | "recovered",
  ) => void;
}

export class OneBotReverseWebSocketServer {
  readonly options: OneBotServerOptions;
  #server: WebSocketServer | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #activeSocket: WebSocket | null = null;

  constructor(options: OneBotServerOptions) {
    if (options.token.length < 32) {
      throw new Error("OneBot 访问令牌至少需要 32 个字符");
    }
    this.options = options;
  }

  async start(): Promise<number> {
    if (this.#server) throw new Error("OneBot 服务已经启动");
    const host = this.options.host ?? "127.0.0.1";
    if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
      throw new Error("OneBot 服务只允许监听回环地址");
    }

    const server = new WebSocketServer({
      host,
      port: this.options.port,
      verifyClient: ({ req }, done) => done(this.isAuthorized(req.headers.authorization)),
    });
    this.#server = server;

    server.on("connection", (socket) => {
      if (this.#activeSocket && this.#activeSocket.readyState === WebSocket.OPEN) {
        socket.close(1013, "已有活动连接");
        return;
      }
      this.#activeSocket = socket;
      const wasDisconnected = this.options.health.snapshot().transport === "disconnected";
      this.options.health.connected();
      this.options.onConnectionEvent?.(wasDisconnected ? "recovered" : "connected");
      socket.on("pong", () => this.options.health.pong());
      socket.on("message", (data) => {
        try {
          this.options.handleEvent(JSON.parse(data.toString()));
        } catch (error) {
          this.options.onInvalidPayload?.(
            error instanceof Error ? error : new Error("无效 OneBot 事件"),
          );
        }
      });
      socket.on("close", () => {
        if (this.#activeSocket === socket) {
          this.#activeSocket = null;
          this.options.health.disconnected();
          this.options.onConnectionEvent?.("disconnected");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    this.#pingTimer = setInterval(() => {
      if (this.#activeSocket?.readyState === WebSocket.OPEN) {
        this.#activeSocket.ping();
      }
      const previous = this.options.health.snapshot().transport;
      const current = this.options.health.evaluate().transport;
      if (previous !== "stale" && current === "stale") {
        this.options.onConnectionEvent?.("stale");
      }
    }, this.options.pingIntervalMs ?? 15_000);
    this.#pingTimer.unref();

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法确定 OneBot 监听端口");
    }
    return address.port;
  }

  async stop(): Promise<void> {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    const server = this.#server;
    this.#server = null;
    if (!server) return;

    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.#activeSocket = null;
    this.options.health.disconnected();
  }

  private isAuthorized(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ")) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.options.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}
