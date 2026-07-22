// One-off check for V2 M2 PR 1: the foundation proof-of-life. DISPOSABLE, not
// a maintained test — see ../../AGENTS.md → "Verifying UI changes".
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010) and
// the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-foundation.mjs
//
// Drives: V2 mode switch → sign-up (main-process auth → api key minted) →
// projects proof-of-life (typed hc read + write) → WS invalidation (a project
// created OUT-OF-BAND over HTTP must appear in the UI with no renderer action,
// proving pg NOTIFY → server WS → main forward → invalidateQueries → refetch).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SERVER_URL = process.env.HITCH_SERVER_URL;
if (!SERVER_URL) {
  console.error("Set HITCH_SERVER_URL (e.g. http://localhost:3010) first.");
  process.exit(1);
}

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-foundation.log");
writeFileSync(LOG, "");

const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
// pass defaults to true: reaching a bare check() means its awaited waitFor
// above resolved (a timeout would have thrown into the catch).
const check = (name, pass = true, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const email = `e2e-${Date.now()}@example.com`;
const password = "hitch-e2e-password";

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-foundation" });
try {
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

  // 1. V2 mode switch: the sign-in screen (not the V1 Convex tree) mounts.
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  const v1Visible = await page
    .getByRole("button", { name: "Continue with GitHub" })
    .count();
  check("1. V2 sign-in screen mounts under HITCH_SERVER_URL", v1Visible === 0);
  await shot("v2-01-signin");

  // 2. Sign-up through the main-process auth flow.
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("E2E User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await shot("v2-02-signup-filled");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 30_000 });
  check("2. sign-up lands on the signed-in projects view");
  await page.getByText("No projects yet.").waitFor({ timeout: 10_000 });
  check("3. fresh account lists zero projects");
  await shot("v2-03-projects-empty");

  // The main process persisted {serverUrl, apiKey} in the isolated secrets.
  const secrets = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  const creds = secrets.hitchServer;
  check(
    "4. api key stored in secrets.json under hitchServer",
    Boolean(creds?.apiKey && creds?.serverUrl === SERVER_URL && creds?.apiKeyId),
    `serverUrl=${creds?.serverUrl} keyId=${creds?.apiKeyId ?? "none"}`,
  );
  log(`api-key=${creds?.apiKey ?? ""}`); // consumed by the session-row risk check

  // 5. Write path: create a project through the UI (POST + invalidation).
  await page.getByLabel("New project name").fill("Proof of Life");
  await page.getByRole("button", { name: "Add" }).click();
  await page
    .locator("[data-testid=v2-projects] li", { hasText: "Proof of Life" })
    .waitFor({ timeout: 10_000 });
  check("5. UI-created project appears in the list");
  await shot("v2-04-project-created");

  // 6. WS invalidation: create a project OUT-OF-BAND (plain HTTP from this
  // script) and assert it shows up with zero renderer interaction.
  const response = await fetch(`${SERVER_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
    body: JSON.stringify({ name: "Via Websocket", sortOrder: "zz" }),
  });
  check("6a. out-of-band POST /projects succeeds", response.status === 201);
  await page
    .locator("[data-testid=v2-projects] li", { hasText: "Via Websocket" })
    .waitFor({ timeout: 10_000 });
  check("6b. out-of-band project appears via WS invalidation (no UI action)");
  await shot("v2-05-ws-invalidation");

  // 7. Sign-out: local creds cleared AND the key revoked server-side (the
  // out-of-band key stops authenticating).
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 10_000 });
  check("7a. sign-out returns to the sign-in screen");
  const after = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  check("7b. hitchServer creds cleared from secrets.json", !after.hitchServer);
  const revoked = await fetch(`${SERVER_URL}/projects`, {
    headers: { "x-api-key": creds.apiKey },
  });
  check("7c. api key revoked server-side", revoked.status === 401, `status=${revoked.status}`);
  await shot("v2-06-signed-out");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-99-error.png") }).catch(() => {});
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
