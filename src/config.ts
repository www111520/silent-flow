import { z } from "zod";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const configSchema = z.object({
  DB_PATH: z.string().min(1).default("data/collector.sqlite"),
  ONEBOT_HOST: z.enum(["127.0.0.1", "::1", "localhost"], {
    error: "OneBot 必须监听回环地址",
  }).default("127.0.0.1"),
  ONEBOT_PORT: z.coerce.number().int().min(0).max(65_535).default(3_001),
  ONEBOT_TOKEN: z.string().min(32),
  ADMIN_HOST: z.enum(["127.0.0.1", "::1", "localhost", "0.0.0.0"], {
    error: "管理工作台监听地址无效",
  }).default("127.0.0.1"),
  ADMIN_PORT: z.coerce.number().int().min(0).max(65_535).default(3_002),
  DISCOVERY_PORT: z.coerce.number().int().min(0).max(65_535).default(3_003),
  ADMIN_TOKEN: z.string().min(32),
  SENDER_SALT: z.string().min(16),
  GROUP_WHITELIST: z.string().min(1).transform((value) =>
    new Set(value.split(",").map((item) => item.trim()).filter(Boolean)),
  ).refine((groups) => groups.size > 0, "群白名单不能为空"),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().min(1),
  LLM_API_KEY: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  BACKUP_DIR: z.string().min(1).default("data/backups"),
  BACKUP_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  BACKUP_KEEP_COUNT: z.coerce.number().int().min(1).max(365).default(7),
  RESERVE_PATH: z.string().min(1).default("data/emergency.reserve"),
  RESERVE_BYTES: z.coerce.number().int().min(0).default(268_435_456),
  MIN_FREE_BYTES: z.coerce.number().int().min(0).default(1_073_741_824),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(environment);
}

export function saveModelConfig(
  path: string,
  values: { baseUrl: string; model: string; apiKey?: string | null | undefined },
): void {
  const updates = new Map<string, string | null>([
    ["LLM_BASE_URL", values.baseUrl],
    ["LLM_MODEL", values.model],
  ]);
  if (values.apiKey !== undefined) updates.set("LLM_API_KEY", values.apiKey);
  saveEnvironmentValues(path, updates);
}

export function saveGroupWhitelist(path: string, groups: readonly string[]): void {
  saveEnvironmentValues(path, new Map([["GROUP_WHITELIST", groups.join(",")]]));
}

function saveEnvironmentValues(path: string, updates: Map<string, string | null>): void {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const key = line.match(/^([A-Z_]+)=/)?.[1];
    if (!key || !updates.has(key)) {
      output.push(line);
      continue;
    }
    const value = updates.get(key);
    updates.delete(key);
    if (value !== null) output.push(`${key}=${JSON.stringify(value)}`);
  }
  for (const [key, value] of updates) {
    if (value !== null) output.push(`${key}=${JSON.stringify(value)}`);
  }
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${output.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}
