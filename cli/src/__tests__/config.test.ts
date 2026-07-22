import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { configPath, deleteConfig, loadConfig, saveConfig } from "../config.js";

// Every test injects its own env so the real ~/.config/hitch is never touched.
function scratchEnv(): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: mkdtempSync(path.join(os.tmpdir(), "hitch-cli-test-")) };
}

describe("configPath", () => {
  it("honors XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/hitch/cli.json");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or blank", () => {
    const expected = path.join(os.homedir(), ".config", "hitch", "cli.json");
    expect(configPath({})).toBe(expected);
    expect(configPath({ XDG_CONFIG_HOME: "  " })).toBe(expected);
  });
});

describe("load/save/delete", () => {
  it("round-trips a config with 0600 permissions", () => {
    const env = scratchEnv();
    saveConfig({ serverUrl: "http://localhost:3010", apiKey: "k", apiKeyId: "id1" }, env);
    expect(loadConfig(env)).toEqual({
      serverUrl: "http://localhost:3010",
      apiKey: "k",
      apiKeyId: "id1",
    });
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });

  it("returns null when no config exists", () => {
    expect(loadConfig(scratchEnv())).toBeNull();
  });

  it("treats corrupt or incomplete files as not-logged-in", () => {
    const env = scratchEnv();
    saveConfig({ serverUrl: "http://x", apiKey: "k" }, env);
    writeFileSync(configPath(env), "not json");
    expect(loadConfig(env)).toBeNull();
    writeFileSync(configPath(env), JSON.stringify({ serverUrl: "http://x" }));
    expect(loadConfig(env)).toBeNull();
  });

  it("deleteConfig removes the file and tolerates absence", () => {
    const env = scratchEnv();
    saveConfig({ serverUrl: "http://x", apiKey: "k" }, env);
    deleteConfig(env);
    expect(loadConfig(env)).toBeNull();
    deleteConfig(env); // second delete is a no-op
  });

  it("writes pretty JSON (the file is user-inspectable)", () => {
    const env = scratchEnv();
    saveConfig({ serverUrl: "http://x", apiKey: "k" }, env);
    expect(readFileSync(configPath(env), "utf8")).toContain('\n  "serverUrl"');
  });
});
