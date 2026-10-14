export type TransportStatus =
  | "connecting"
  | "connected"
  | "stale"
  | "disconnected";

export interface HealthSnapshot {
  transport: TransportStatus;
  connectedAt: number | null;
  lastPongAt: number | null;
  disconnectedAt: number | null;
  napCat: "normal" | "abnormal" | "unknown";
  qq: "online" | "offline" | "unknown";
  lastOneBotHeartbeatAt: number | null;
}

export class ConnectionHealth {
  readonly staleAfterMs: number;
  #snapshot: HealthSnapshot = {
    transport: "connecting",
    connectedAt: null,
    lastPongAt: null,
    disconnectedAt: null,
    napCat: "unknown",
    qq: "unknown",
    lastOneBotHeartbeatAt: null,
  };

  constructor(staleAfterMs = 45_000) {
    this.staleAfterMs = staleAfterMs;
  }

  connected(now = Date.now()): void {
    this.#snapshot = {
      ...this.#snapshot,
      transport: "connected",
      connectedAt: now,
      lastPongAt: now,
      disconnectedAt: null,
    };
  }

  pong(now = Date.now()): void {
    if (this.#snapshot.transport === "disconnected") return;
    this.#snapshot = {
      ...this.#snapshot,
      transport: "connected",
      lastPongAt: now,
    };
  }

  oneBotHeartbeat(good: boolean, online: boolean, now = Date.now()): void {
    if (this.#snapshot.transport === "disconnected") return;
    this.#snapshot = {
      ...this.#snapshot,
      napCat: good ? "normal" : "abnormal",
      qq: online ? "online" : "offline",
      lastOneBotHeartbeatAt: now,
    };
  }

  disconnected(now = Date.now()): void {
    this.#snapshot = {
      ...this.#snapshot,
      transport: "disconnected",
      disconnectedAt: now,
      napCat: "unknown",
      qq: "unknown",
    };
  }

  evaluate(now = Date.now()): HealthSnapshot {
    const lastPongAt = this.#snapshot.lastPongAt;
    if (
      (this.#snapshot.transport === "connected" ||
        this.#snapshot.transport === "stale") &&
      lastPongAt !== null &&
      now - lastPongAt >= this.staleAfterMs
    ) {
      this.#snapshot = {
        ...this.#snapshot,
        transport: "stale",
        napCat: "unknown",
        qq: "unknown",
      };
    }
    return { ...this.#snapshot };
  }

  snapshot(): HealthSnapshot {
    return { ...this.#snapshot };
  }
}
