// Project working directory, end to end: set it in the UI, and prove the daemon
// spawns the agent THERE rather than in the home folder.
// DISPOSABLE, not a maintained suite — see ../../AGENTS.md.
//
// This exists because the failure it guards was silent. `projects.repo_path`
// was modelled, read by the reconciler, and written by nothing — so every
// delegation quietly fell back to homedir() and agents opened with none of the
// project's files in view. Nothing failed; the cwd was just wrong.
//
// The fake daemon (HITCH_FAKE_LAUNCH=1) logs its spawn cwd, which is what turns
// "wrong directory" into an assertable fact without opening a real terminal.
//
// Prereqs:
//   - docker running (the script brings compose up unless SKIP_COMPOSE=1)
//   - the Vite dev renderer on :5173 (npm run dev:renderer)
//
// Run:
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-project-cwd.mjs

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

// Exactly ONE daemon per machine. This script runs its own fake-launch daemon,
// so the app's must stand down — two reconcilers race for the same assignment,
// and the app's (real cmux, not fake) wins the claim by PATCHing `spawning`
// first, after which the fake one correctly declines to spawn and the run just
// hangs at `spawning` with nothing in this script's log to explain it.
process.env.HITCH_DISABLE_APP_DAEMON = "1";

// Normalized AND written back: the Electron app this script launches reads the
// server URL from the environment too. Resolving it only locally would poll one
// server while the app talked to none, surfacing as "Sign in never appeared".
const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
process.env.HITCH_SERVER_URL = SERVER_URL;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-project-cwd.log");
writeFileSync(LOG, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  console.log(m);
  appendFileSync(LOG, `${m}\n`);
};
const compose = (args) => {
  const res = spawnSync("docker", ["compose", ...args], { cwd: REPO_ROOT, stdio: "inherit" });
  // Fail loudly: a broken `up` otherwise degrades into a 60s health-poll
  // timeout that reads like the server is slow rather than absent.
  if (res.status !== 0) throw new Error(`docker compose ${args.join(" ")} → ${res.status}`);
};

let passed = 0;
let failed = 0;
function check(label, ok = true, detail = "") {
  if (ok) {
    passed++;
    log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const stamp = Date.now();
const email = `cwd-${stamp}@e2e.local`;
const password = "hitch-e2e-password";

let daemon;
let scratch;
let projectDir;
let daemonOut = "";
let cleanupApp = async () => {};

try {
  if (process.env.SKIP_COMPOSE !== "1") {
    log("→ docker compose up -d --build");
    compose(["up", "-d", "--build"]);
  }
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${SERVER_URL}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await sleep(1000);
    if (i === 59) throw new Error(`server never healthy at ${SERVER_URL}`);
  }
  log(`server healthy at ${SERVER_URL}`);

  // A real directory to point the project at — distinct from homedir(), which
  // is the fallback this whole check exists to distinguish from.
  projectDir = mkdtempSync(join(tmpdir(), "hitch-project-cwd-"));

  const launched = await launchHitch({ profile: "v2-project-cwd" });
  const { page, stateDir } = launched;
  cleanupApp = launched.cleanup;
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("CWD E2E");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("[data-testid=v2-project-row]", { hasText: "Inbox" }).waitFor({ timeout: 30_000 });
  check("1. signed up into the V2 workspace");

  const creds = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8")).hitchServer;
  if (!creds?.apiKey) throw new Error("no api key stored after sign-up");
  const api = async (method, path, body) => {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  async function waitFor(label, fn, { timeoutMs = 25_000, everyMs = 200 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      last = await fn().catch(() => undefined);
      if (last) return last;
      await sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
  }

  // ── a non-Inbox project, since Inbox deliberately has no settings ────────
  const project = await api("POST", "/projects", { name: "Repo Project", sortOrder: "a1" });
  const projectRow = page.locator("[data-testid=v2-project-row]", { hasText: "Repo Project" });
  await projectRow.waitFor({ timeout: 15_000 });
  check("2. created a project (repoPath starts null)", project.repoPath === null);

  // ── set the working directory THROUGH THE UI ─────────────────────────────
  await projectRow.click({ button: "right" });
  const settingsItem = page.getByRole("menuitem", { name: "Project settings…" });
  await settingsItem.waitFor({ timeout: 10_000 });
  await settingsItem.click();
  await page.getByRole("heading", { name: "Project settings" }).waitFor({ timeout: 10_000 });
  check("3. right-click → Project settings… opens the dialog");

  // The empty state names the real fallback, which is the thing a user needs to
  // understand: "not set" means home, not "nowhere".
  const home = homedir();
  const dialog = page.locator("[role=dialog]", { hasText: "Project settings" });
  // innerText, not a text= locator: a path starts with "/" and Playwright reads
  // that as a regex. Polled, because the home path arrives over IPC a beat
  // after the dialog paints — asserting immediately would be a race that
  // happens to pass.
  const namesHome = await waitFor(
    "the dialog to show the home path",
    async () => ((await dialog.innerText()).includes(home) ? true : undefined),
    { timeoutMs: 10_000 },
  ).catch(() => false);
  check("4. the empty state names the home-folder fallback", namesHome === true, home);
  await shot("v2-project-cwd-01-empty");

  const pathInput = dialog.locator("input.font-mono");
  await pathInput.fill(projectDir);
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Project settings" }).waitFor({
    state: "hidden",
    timeout: 10_000,
  });

  const saved = await waitFor("repoPath persisted", async () => {
    const row = (await api("GET", "/projects")).find((p) => p.id === project.id);
    return row?.repoPath ? row : undefined;
  });
  check("5. saving stored repoPath on the project", saved.repoPath === projectDir, saved.repoPath);
  check("6. and left the name alone", saved.name === "Repo Project", saved.name);

  // ── the daemon spawns THERE, not in homedir() ────────────────────────────
  scratch = mkdtempSync(join(tmpdir(), "hitch-cwd-daemon-"));
  daemon = spawn("npx", ["tsx", "daemon/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HITCH_SERVER_URL: SERVER_URL,
      HITCH_API_KEY: creds.apiKey,
      HITCH_FAKE_LAUNCH: "1",
      HITCH_APP_SUPPORT_DIR: scratch,
      HITCH_RECONCILE_MS: "600",
      HITCH_HEARTBEAT_MS: "4000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream.on("data", (d) => {
      daemonOut += d;
      appendFileSync(LOG, `[daemon] ${d}`);
    });
  }
  daemon.on("exit", (code, signal) =>
    appendFileSync(LOG, `[daemon] EXITED code=${code} signal=${signal}\n`),
  );
  daemon.on("error", (e) => appendFileSync(LOG, `[daemon] ERROR ${String(e)}\n`));

  const machine = await waitFor("machine registration", async () => {
    const rows = await api("GET", "/machines");
    return rows[0];
  });
  check("7. fake daemon registered its machine", Boolean(machine?.id), machine?.name);

  const task = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Work in the repo",
    body: "Look around.",
    sortOrder: "a0",
  });
  await api("POST", "/assignments", {
    taskId: task.id,
    machineId: machine.id,
    harness: "claude",
    desiredState: "running",
  });

  // Match a COMPLETE line: stdout arrives in chunks, and a boundary mid-path
  // would otherwise let the assertion below compare a truncated cwd.
  const cwdLines = (text) =>
    [...text.matchAll(/fake-launch:.*cwd=(.+)\n/g)].map((m) => m[1].trim());
  const spawnedCwd = await waitFor(
    "fake launch logs its cwd",
    async () => cwdLines(daemonOut).at(-1),
    { timeoutMs: 30_000 },
  );
  check(
    "8. the agent spawned in the project's working directory",
    spawnedCwd === projectDir,
    `cwd=${spawnedCwd}`,
  );
  check(
    "9. …and NOT in the home folder (the old silent fallback)",
    spawnedCwd !== home,
    `home=${home}`,
  );

  // ── clearing it falls back to home again ─────────────────────────────────
  await projectRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Project settings…" }).click();
  await page.getByRole("heading", { name: "Project settings" }).waitFor({ timeout: 10_000 });
  await dialog.locator("input.font-mono").fill("");
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Project settings" }).waitFor({
    state: "hidden",
    timeout: 10_000,
  });
  const cleared = await waitFor("repoPath cleared", async () => {
    const row = (await api("GET", "/projects")).find((p) => p.id === project.id);
    return row && row.repoPath === null ? row : undefined;
  });
  check("10. clearing the field stores null, not an empty string", cleared.repoPath === null);
  await shot("v2-project-cwd-02-set");

  const before = daemonOut.length;
  const task2 = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Work anywhere",
    body: "No repo.",
    sortOrder: "a1",
  });
  await api("POST", "/assignments", {
    taskId: task2.id,
    machineId: machine.id,
    harness: "claude",
    desiredState: "running",
  });
  const secondCwd = await waitFor(
    "second fake launch",
    // Sliced from where the first launch ended, so this can't read the stale
    // line and "pass" by re-reading the previous spawn.
    async () => cwdLines(daemonOut.slice(before)).at(-1),
    { timeoutMs: 30_000 },
  );
  check("11. with no working directory, agents fall back to home", secondCwd === home, secondCwd);
} catch (error) {
  failed++;
  log(`FAIL  ${String(error?.stack ?? error)}`);
} finally {
  await cleanupApp().catch(() => {});
  // SIGINT, matching the sibling: the child is `npx`, and SIGTERM can leave the
  // tsx grandchild running.
  if (daemon) daemon.kill("SIGINT");
  for (const dir of [scratch, projectDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  if (process.env.SKIP_COMPOSE !== "1") {
    log("→ docker compose down -v");
    try {
      compose(["down", "-v"]);
    } catch (e) {
      log(`(compose down failed: ${String(e)})`);
    }
  }
  log(`\nlog: ${LOG}`);
  log(`${passed}/${passed + failed} checks passed.`);
  process.exit(failed === 0 ? 0 : 1);
}
