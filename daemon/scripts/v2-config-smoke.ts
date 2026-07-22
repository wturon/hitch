import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isServerMode, resolveServerConfig } from "../src/v2/config.js";

// Base env with the V1/app-support resolution knobs stripped so the platform
// default never leaks into a test.
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    // Point the secrets fallback at a definitely-absent file unless a test
    // overrides HITCH_SECRETS_PATH.
    HITCH_SECRETS_PATH: join(tmpdir(), "hitch-v2-config-smoke-absent.json"),
    ...overrides,
  };
}

function writeSecrets(hitchServer: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "hitch-v2-config-"));
  const path = join(dir, "secrets.json");
  writeFileSync(path, JSON.stringify({ deviceToken: "x", hitchServer }, null, 2));
  return path;
}

// --- isServerMode -----------------------------------------------------------
assert.equal(isServerMode({}), false, "no HITCH_SERVER_URL → not server mode");
assert.equal(isServerMode({ HITCH_SERVER_URL: "  " }), false, "blank URL → not server mode");
assert.equal(
  isServerMode({ HITCH_SERVER_URL: "http://localhost:3010" }),
  true,
  "URL present → server mode",
);

// --- not server mode → null (V1 fallthrough) --------------------------------
assert.equal(resolveServerConfig(baseEnv()), null, "no URL → null, never throws");

// --- env api key wins -------------------------------------------------------
assert.deepEqual(
  resolveServerConfig(
    baseEnv({ HITCH_SERVER_URL: "http://localhost:3010", HITCH_API_KEY: "env-key" }),
  ),
  { serverUrl: "http://localhost:3010", apiKey: "env-key" },
  "HITCH_API_KEY is used verbatim",
);

// --- trailing slash normalized ----------------------------------------------
assert.deepEqual(
  resolveServerConfig(
    baseEnv({ HITCH_SERVER_URL: "http://localhost:3010///", HITCH_API_KEY: "env-key" }),
  ),
  { serverUrl: "http://localhost:3010", apiKey: "env-key" },
  "trailing slashes stripped from the server URL",
);

// --- env key beats stored key -----------------------------------------------
{
  const path = writeSecrets({ serverUrl: "http://localhost:3010", apiKey: "stored-key" });
  assert.deepEqual(
    resolveServerConfig(
      baseEnv({
        HITCH_SERVER_URL: "http://localhost:3010",
        HITCH_API_KEY: "env-key",
        HITCH_SECRETS_PATH: path,
      }),
    ),
    { serverUrl: "http://localhost:3010", apiKey: "env-key" },
    "env key wins over stored key",
  );
}

// --- fallback: stored secrets.json for the same server ----------------------
{
  const path = writeSecrets({ serverUrl: "http://localhost:3010", apiKey: "stored-key" });
  assert.deepEqual(
    resolveServerConfig(
      baseEnv({ HITCH_SERVER_URL: "http://localhost:3010", HITCH_SECRETS_PATH: path }),
    ),
    { serverUrl: "http://localhost:3010", apiKey: "stored-key" },
    "stored key used when URL matches",
  );
}

// --- fallback: stored serverUrl trailing-slash tolerant ---------------------
{
  const path = writeSecrets({ serverUrl: "http://localhost:3010/", apiKey: "stored-key" });
  assert.deepEqual(
    resolveServerConfig(
      baseEnv({ HITCH_SERVER_URL: "http://localhost:3010", HITCH_SECRETS_PATH: path }),
    ),
    { serverUrl: "http://localhost:3010", apiKey: "stored-key" },
    "stored serverUrl matches modulo trailing slash",
  );
}

// --- stored key for a DIFFERENT server → clear error ------------------------
{
  const path = writeSecrets({ serverUrl: "https://prod.example.com", apiKey: "stored-key" });
  assert.throws(
    () =>
      resolveServerConfig(
        baseEnv({ HITCH_SERVER_URL: "http://localhost:3010", HITCH_SECRETS_PATH: path }),
      ),
    /minted for https:\/\/prod\.example\.com/,
    "mismatched stored server → teaching error, no silent use",
  );
}

// --- URL set, no key anywhere → clear error ---------------------------------
assert.throws(
  () => resolveServerConfig(baseEnv({ HITCH_SERVER_URL: "http://localhost:3010" })),
  /no API key was found/,
  "URL with no resolvable key throws, never falls through to V1",
);

// --- stored hitchServer without apiKey → treated as no key ------------------
{
  const path = writeSecrets({ serverUrl: "http://localhost:3010" });
  assert.throws(
    () =>
      resolveServerConfig(
        baseEnv({ HITCH_SERVER_URL: "http://localhost:3010", HITCH_SECRETS_PATH: path }),
      ),
    /no API key was found/,
    "stored record with no apiKey → still an error",
  );
}

console.log("v2-config smoke OK");
