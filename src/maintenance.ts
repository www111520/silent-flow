import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CollectorDatabase } from "./database.js";

export interface StorageGuardOptions {
  reservePath: string;
  reserveBytes: number;
  minimumFreeBytes: number;
}

export class StorageGuard {
  readonly options: StorageGuardOptions;

  constructor(options: StorageGuardOptions) {
    this.options = options;
  }

  ensureReserve(): void {
    const { reservePath, reserveBytes } = this.options;
    if (reserveBytes <= 0) return;
    if (existsSync(reservePath) && statSync(reservePath).size === reserveBytes) return;
    mkdirSync(dirname(reservePath), { recursive: true });
    const descriptor = openSync(reservePath, "w");
    const chunk = Buffer.alloc(Math.min(1024 * 1024, reserveBytes));
    try {
      let written = 0;
      while (written < reserveBytes) {
        written += writeSync(
          descriptor,
          chunk,
          0,
          Math.min(chunk.length, reserveBytes - written),
        );
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  releaseIfLowSpace(): boolean {
    const stats = statfsSync(dirname(this.options.reservePath));
    const availableBytes = stats.bavail * stats.bsize;
    if (
      availableBytes >= this.options.minimumFreeBytes ||
      !existsSync(this.options.reservePath)
    ) {
      return false;
    }
    unlinkSync(this.options.reservePath);
    return true;
  }
}

export interface MaintenanceOptions {
  backupDirectory: string;
  backupKeepCount: number;
  intervalMs: number;
  storageGuard: StorageGuard;
  now?: () => Date;
}

export class MaintenanceLoop {
  readonly store: CollectorDatabase;
  readonly options: MaintenanceOptions;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<void> | null = null;

  constructor(store: CollectorDatabase, options: MaintenanceOptions) {
    this.store = store;
    this.options = options;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.options.storageGuard.ensureReserve();
    this.schedule(this.options.intervalMs);
  }

  async runOnce(): Promise<string> {
    this.options.storageGuard.releaseIfLowSpace();
    mkdirSync(this.options.backupDirectory, { recursive: true });
    const timestamp = (this.options.now ?? (() => new Date()))()
      .toISOString()
      .replaceAll(":", "-");
    const path = join(this.options.backupDirectory, `backup-${timestamp}.sqlite`);
    await this.store.backupTo(path);
    this.pruneBackups();
    return path;
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
      this.#active = this.runOnce()
        .catch(() => undefined)
        .then(() => undefined)
        .finally(() => {
          this.#active = null;
          this.schedule(this.options.intervalMs);
        });
    }, delay);
    this.#timer.unref();
  }

  private pruneBackups(): void {
    const backups = readdirSync(this.options.backupDirectory)
      .filter((name) => /^backup-.*\.sqlite$/.test(name))
      .sort()
      .reverse();
    for (const name of backups.slice(this.options.backupKeepCount)) {
      unlinkSync(join(this.options.backupDirectory, name));
    }
  }
}
