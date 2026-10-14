import { CollectorDatabase } from "./database.js";
import type { Analyzer } from "./worker.js";
import { runOneJob } from "./worker.js";

export class AnalysisWorkerLoop {
  readonly store: CollectorDatabase;
  readonly analyzer: Analyzer;
  readonly idleDelayMs: number;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<void> | null = null;

  constructor(
    store: CollectorDatabase,
    analyzer: Analyzer,
    idleDelayMs = 500,
  ) {
    this.store = store;
    this.analyzer = analyzer;
    this.idleDelayMs = idleDelayMs;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#active;
  }

  private schedule(delay: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#active = this.tick().finally(() => {
        this.#active = null;
      });
    }, delay);
    this.#timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const result = await runOneJob(this.store, this.analyzer);
      this.schedule(result === "idle" || result === "paused" ? this.idleDelayMs : 0);
    } catch {
      this.schedule(this.idleDelayMs);
    }
  }
}
