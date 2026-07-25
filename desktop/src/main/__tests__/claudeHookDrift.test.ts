import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// main.ts resolves every path it touches at import time, so point the whole
// footprint (app-support dir, ~/.claude, HOME) at a scratch dir BEFORE importing
// it. The test then installs, corrupts and heals real hook files without ever
// touching the developer's machine.
const tmpHome = mkdtempSync(join(tmpdir(), "hitch-claude-hooks-"));
const appSupportDir = join(tmpHome, "app-support");
const claudeConfigDir = join(tmpHome, "dot-claude");
process.env.HOME = tmpHome;
process.env.HITCH_ROOT = join(tmpHome, "repo");
process.env.HITCH_APP_SUPPORT_DIR = appSupportDir;
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
delete process.env.HITCH_CONFIG_PATH;
delete process.env.HITCH_SECRETS_PATH;
delete process.env.HITCH_PREFERENCES_PATH;
delete process.env.HITCH_SERVER_URL;

// electron is unavailable under vitest's node env. Stub it with an ipcMain that
// records handlers (the only seam onto main.ts's module-private functions) and
// a whenReady() that never resolves, so importing main.ts does not open a
// window, spawn the daemon, or run the startup auto-heal.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    setName: () => {},
    getPath: () => tmpHome,
    getAppPath: () => tmpHome,
    getVersion: () => "0.0.0-test",
    whenReady: () => new Promise<void>(() => {}),
    on: () => {},
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  clipboard: {},
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  nativeTheme: {},
}));
vi.mock("electron-updater", () => ({ autoUpdater: { on: () => {} } }));

await import("../main.js");

interface HarnessHookStatus {
  installed: boolean;
  scriptPath: string | null;
  scriptExists: boolean;
  configWired: boolean;
}
interface IntegrationHealth {
  integrations: Array<{ id: string; state: string }>;
}

function invoke<T>(channel: string, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no ipcMain handler for ${channel}`);
  return handler({}, ...args) as T;
}

function claudeStatus(): HarnessHookStatus {
  return invoke<{ claudeCode: HarnessHookStatus }>(
    "config:get-global-harness-setup",
  ).claudeCode;
}

function codexStatus(): HarnessHookStatus {
  return invoke<{ codex: HarnessHookStatus }>("config:get-global-harness-setup")
    .codex;
}

async function claudeIntegrationState(): Promise<string> {
  const health = await invoke<Promise<IntegrationHealth>>("integrations:check");
  const claude = health.integrations.find(
    (i) => i.id === "claude.hitch-lifecycle-hooks",
  );
  return claude?.state ?? "missing";
}

describe("Claude Code lifecycle hook drift detection", () => {
  let scriptPath: string;
  // The template this build embeds — captured from a known-good fresh install.
  let template: string;

  beforeEach(() => {
    rmSync(appSupportDir, { recursive: true, force: true });
    rmSync(claudeConfigDir, { recursive: true, force: true });
    invoke("config:install-global-claude-hooks");
    const status = claudeStatus();
    scriptPath = status.scriptPath as string;
    template = readFileSync(scriptPath, "utf8");
  });

  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reports ok when the installed script matches the template", async () => {
    expect(claudeStatus().installed).toBe(true);
    expect(await claudeIntegrationState()).toBe("ok");
  });

  it("reports drifted when the on-disk script no longer matches the template", async () => {
    // Exactly the upgrade case: settings.json still wires the same command, and
    // the script file still exists — only its body is from an older Hitch.
    writeFileSync(scriptPath, "#!/usr/bin/env node\n// stale hook from v0.1.15\n", "utf8");

    const status = claudeStatus();
    expect(status.scriptExists).toBe(true);
    expect(status.configWired).toBe(true);
    expect(status.installed).toBe(false);
    expect(await claudeIntegrationState()).toBe("drifted");
  });

  it("heals a drifted script back to the template byte-for-byte", async () => {
    writeFileSync(scriptPath, "// stale\n", "utf8");
    expect(await claudeIntegrationState()).toBe("drifted");

    // The same install that healDriftedHarnessHooks() runs for a "drifted" status.
    await invoke<Promise<IntegrationHealth>>(
      "integrations:repair",
      "claude.hitch-lifecycle-hooks",
    );

    expect(readFileSync(scriptPath, "utf8")).toBe(template);
    expect(claudeStatus().installed).toBe(true);
    expect(await claudeIntegrationState()).toBe("ok");
  });

  it("keeps the same drift check on the Codex side", () => {
    invoke("config:install-global-codex-hooks");
    expect(codexStatus().installed).toBe(true);

    writeFileSync(codexStatus().scriptPath as string, "// stale\n", "utf8");
    const drifted = codexStatus();
    expect(drifted.scriptExists).toBe(true);
    expect(drifted.configWired).toBe(true);
    expect(drifted.installed).toBe(false);
  });
});
