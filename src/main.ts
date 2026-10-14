import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleAnalyzer } from "./analyzer.js";
import { AdminServer } from "./admin.js";
import { loadConfig, saveGroupWhitelist, saveModelConfig } from "./config.js";
import { CollectorDatabase } from "./database.js";
import { LocalDiscoveryService } from "./discovery.js";
import { ConnectionHealth } from "./health.js";
import { createOneBotEventHandler } from "./onebot.js";
import { MaintenanceLoop, StorageGuard } from "./maintenance.js";
import { AnalysisWorkerLoop } from "./runtime.js";
import { OneBotReverseWebSocketServer } from "./server.js";

export async function startApplication(environment = process.env): Promise<{
  oneBotPort: number;
  adminPort: number;
  adminUrl: string;
  discoveryPort: number;
  stop: () => Promise<void>;
}> {
  const config = loadConfig(environment);
  mkdirSync(dirname(config.DB_PATH), { recursive: true });
  const store = new CollectorDatabase(config.DB_PATH);
  const health = new ConnectionHealth();
  const handler = createOneBotEventHandler({
    store,
    groupWhitelist: config.GROUP_WHITELIST,
    senderSalt: config.SENDER_SALT,
    onHeartbeat: (good, online) => health.oneBotHeartbeat(good, online),
  });
  const server = new OneBotReverseWebSocketServer({
    host: config.ONEBOT_HOST,
    port: config.ONEBOT_PORT,
    token: config.ONEBOT_TOKEN,
    health,
    handleEvent: handler,
    onConnectionEvent: (type) => store.recordConnectionEvent(type),
  });
  const analyzer = new OpenAICompatibleAnalyzer({
    baseUrl: config.LLM_BASE_URL,
    model: config.LLM_MODEL,
    timeoutMs: config.LLM_TIMEOUT_MS,
    ...(config.LLM_API_KEY ? { apiKey: config.LLM_API_KEY } : {}),
  });
  const admin = new AdminServer({
    host: config.ADMIN_HOST,
    port: config.ADMIN_PORT,
    token: config.ADMIN_TOKEN,
    store,
    health,
    getModelConfig: () => ({
      baseUrl: analyzer.options.baseUrl,
      model: analyzer.options.model,
      hasApiKey: Boolean(analyzer.options.apiKey),
    }),
    updateModelConfig: (values) => {
      saveModelConfig(resolve(".env"), values);
      analyzer.configure(values);
    },
    getGroupWhitelist: () => [...config.GROUP_WHITELIST],
    updateGroupWhitelist: (groups) => {
      saveGroupWhitelist(resolve(".env"), groups);
      config.GROUP_WHITELIST.clear();
      for (const group of groups) config.GROUP_WHITELIST.add(group);
    },
  });
  const worker = new AnalysisWorkerLoop(store, analyzer);
  const maintenance = new MaintenanceLoop(store, {
    backupDirectory: config.BACKUP_DIR,
    backupKeepCount: config.BACKUP_KEEP_COUNT,
    intervalMs: config.BACKUP_INTERVAL_MS,
    storageGuard: new StorageGuard({
      reservePath: config.RESERVE_PATH,
      reserveBytes: config.RESERVE_BYTES,
      minimumFreeBytes: config.MIN_FREE_BYTES,
    }),
  });

  let oneBotPort: number;
  let adminPort: number;
  let discovery: LocalDiscoveryService | null = null;
  let discoveryPort: number;
  try {
    oneBotPort = await server.start();
    adminPort = await admin.start();
    discovery = new LocalDiscoveryService(config.DISCOVERY_PORT, adminPort);
    discoveryPort = await discovery.start();
    worker.start();
    maintenance.start();
  } catch (error) {
    await Promise.allSettled([
      admin.stop(),
      discovery?.stop(),
      server.stop(),
      worker.stop(),
      maintenance.stop(),
    ]);
    store.close();
    throw error;
  }

  let stopped = false;
  return {
    oneBotPort,
    adminPort,
    discoveryPort,
    adminUrl: config.ADMIN_HOST === "::1"
      ? `http://[::1]:${adminPort}`
      : `http://${config.ADMIN_HOST}:${adminPort}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      const results = await Promise.allSettled([
        admin.stop(),
        discovery?.stop(),
        server.stop(),
        worker.stop(),
        maintenance.stop(),
      ]);
      store.close();
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const application = await startApplication();
  console.log(`管理工作台：${application.adminUrl}`);
  const shutdown = async () => {
    await application.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
