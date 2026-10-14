import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorDatabase } from "../src/database.js";
import { MaintenanceLoop, StorageGuard } from "../src/maintenance.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "qq-maintenance-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("磁盘紧急空间", () => {
  it("真实写入指定大小，并在低空间阈值触发时释放", () => {
    const directory = temporaryDirectory();
    const reservePath = join(directory, "emergency.reserve");
    const guard = new StorageGuard({
      reservePath,
      reserveBytes: 4_096,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    });

    guard.ensureReserve();
    expect(statSync(reservePath).size).toBe(4_096);
    expect(guard.releaseIfLowSpace()).toBe(true);
    expect(existsSync(reservePath)).toBe(false);
  });
});

describe("自动维护", () => {
  it("生成经过检查的在线备份并按数量轮换", async () => {
    const directory = temporaryDirectory();
    const store = new CollectorDatabase(join(directory, "collector.sqlite"));
    store.ingest({
      selfId: "1",
      groupId: "2",
      messageId: "3",
      senderHash: "a".repeat(64),
      receivedAt: 100,
      rawSegments: [{ type: "text", data: { text: "更新" } }],
      normalizedText: "更新",
    });
    let day = 1;
    const backupDirectory = join(directory, "backups");
    const loop = new MaintenanceLoop(store, {
      backupDirectory,
      backupKeepCount: 2,
      intervalMs: 60_000,
      storageGuard: new StorageGuard({
        reservePath: join(directory, "emergency.reserve"),
        reserveBytes: 0,
        minimumFreeBytes: 0,
      }),
      now: () => new Date(`2026-01-0${day++}T00:00:00.000Z`),
    });

    await loop.runOnce();
    await loop.runOnce();
    await loop.runOnce();
    expect(readdirSync(backupDirectory).filter((name) => name.endsWith(".sqlite")))
      .toHaveLength(2);
    store.close();
  });
});

describe("Windows 登录启动脚本", () => {
  it("限定当前用户登录触发、受控重启且提供可逆卸载", async () => {
    const install = await readFile(
      new URL("../scripts/install-startup.ps1", import.meta.url),
      "utf8",
    );
    const uninstall = await readFile(
      new URL("../scripts/uninstall-startup.ps1", import.meta.url),
      "utf8",
    );
    for (const rule of [
      "New-ScheduledTaskTrigger -AtLogOn",
      "-LogonType Interactive",
      "-RunLevel Limited",
      "-RestartCount 3",
      "-MultipleInstances IgnoreNew",
      "-AllowStartIfOnBatteries",
      "-DontStopIfGoingOnBatteries",
      "-StartWhenAvailable",
      "-WindowStyle Hidden",
    ]) {
      expect(install).toContain(rule);
    }
    expect(uninstall).toContain("Unregister-ScheduledTask");
    expect(uninstall).toContain("-Confirm:$false");
    expect(install).toContain('$TaskName-Model');
    expect(install).toContain('$TaskName-NapCat');
    expect(install).toContain("-LiteralPath $NodeExecutable -PathType Leaf");
    expect(install).toContain('run-collector.ps1');
    expect(install).toContain("-NodeExecutable `\"$resolvedNode`\"");
    expect(install).toContain('run-model.ps1');
    expect(install).toContain('run-napcat.ps1');
    expect(install.match(/New-ScheduledTaskAction/g)).toHaveLength(1);
    expect(uninstall).toContain('"$TaskName-Model"');
    expect(uninstall).toContain('"$TaskName-NapCat"');
  });

  it("模型与 NapCat 包装器以隐藏任务的前台子进程运行", async () => {
    const modelRunner = await readFile(
      new URL("../scripts/run-model.ps1", import.meta.url),
      "utf8",
    );
    const napCatRunner = await readFile(
      new URL("../scripts/run-napcat.ps1", import.meta.url),
      "utf8",
    );
    expect(modelRunner).toContain("--host 127.0.0.1 --port 11434");
    expect(modelRunner).toContain("--alias $ModelAlias");
    expect(napCatRunner).toContain("& $NapCatExecutable $QuickLogin");
    expect(modelRunner).toContain("exit $LASTEXITCODE");
    expect(napCatRunner).toContain("exit $LASTEXITCODE");
  });

  it("采集器包装器在稳定目录中以前台子进程运行", async () => {
    const runner = await readFile(
      new URL("../scripts/run-collector.ps1", import.meta.url),
      "utf8",
    );
    expect(runner).toContain("Set-Location -LiteralPath $ProjectDirectory");
    expect(runner).toContain("& $NodeExecutable --env-file=.env dist/src/main.js");
    expect(runner).toContain("exit $LASTEXITCODE");
    expect(runner).not.toContain("Push-Location");
  });

  it("README 如实记录目标机联调状态和剩余观察项", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    expect(readme).toContain("真实 NapCat、QQ 账号、本地模型、回环网络连接和登录启动任务均已联调");
    expect(readme).toContain("首条自然产生的新消息观察一次真实接收、落库和分析闭环");
    expect(readme).not.toContain("尚未在当前仓库环境中完成真实 NapCat");
    expect(readme).not.toContain("430965715");
  });

  it("本机配置脚本生成独立随机令牌并拒绝静默覆盖", async () => {
    const configure = await readFile(
      new URL("../scripts/configure-local.ps1", import.meta.url),
      "utf8",
    );
    expect(configure).toContain("RandomNumberGenerator");
    expect(configure).toContain("ONEBOT_TOKEN=$(New-LocalSecret 32)");
    expect(configure).toContain("ADMIN_TOKEN=$(New-LocalSecret 32)");
    expect(configure).toContain('ADMIN_HOST=0.0.0.0');
    expect(configure).toContain("SENDER_SALT=$(New-LocalSecret 24)");
    expect(configure).toContain("-not $Force");
    expect(configure).toContain("[IO.File]::WriteAllLines");
  });
});
