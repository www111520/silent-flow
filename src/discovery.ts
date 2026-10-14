import { createSocket, type Socket } from "node:dgram";

export const DISCOVERY_QUERY = "GRASSWOOD_DISCOVER_V1";
export const DISCOVERY_RESPONSE = "GRASSWOOD_WORKBENCH_V1";

export class LocalDiscoveryService {
  #socket: Socket | null = null;

  constructor(private readonly port: number, private readonly adminPort: number) {}

  async start(): Promise<number> {
    if (this.#socket) throw new Error("局域网发现服务已启动");
    const socket = createSocket("udp4");
    this.#socket = socket;
    socket.on("message", (message, remote) => {
      if (message.toString("utf8") !== DISCOVERY_QUERY) return;
      socket.send(
        `${DISCOVERY_RESPONSE}:${this.adminPort}`,
        remote.port,
        remote.address,
      );
    });
    return new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("listening", () => {
        socket.off("error", reject);
        socket.on("error", () => undefined);
        resolve((socket.address() as { port: number }).port);
      });
      socket.bind(this.port, "0.0.0.0");
    });
  }

  async stop(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}
