// REAL-MACHINE test for M4 PR 3 (reconciler core). DISPOSABLE — not a
// maintained test. Drives the V2 daemon against the compose stack + REAL cmux
// on this Mac and asserts the full desired/observed loop end-to-end:
//
//   POST assignment (desired=running, claude) →
//     a real cmux tab opens with claude running the task prompt →
//     assignment walks pending → spawning → running →
//     the claude turn finishes → waiting_input →
//   PATCH desired=stopped → the tab closes → observed → done.
//
// Prereqs:
//   1. compose stack up:  docker compose up -d --build   (server on :3010)
//   2. cmux running & reachable (its socket accepts this process tree)
//   3. the "Hitch Dev" claude hook installed (desktop was run once) — the daemon
//      runs with HITCH_ROOT=1 so it shares that store, and the hook's
//      turn.completed event is what advances running → waiting_input.
//
// Run:  node daemon/scripts/v2-reconciler-real-machine.mjs
//
// Cleanup is automatic (closes the tab via desired=stopped, kills the daemon,
// removes the scratch dir). `docker compose down -v` is left to the caller.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LOG = join(tmpdir(), `v2-reconciler-real-${Date.now()}.log`);
writeFileSync(LOG, "");

const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass = true, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux";
async function cmuxTree() {
  return await new Promise((res) => {
    const p = spawn(CMUX, ["tree", "--all"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(out));
    p.on("error", () => res(""));
  });
}

// ─── auth ────────────────────────────────────────────────────────────────────
const email = `recon-${Date.now()}@example.com`;
const password = "hitch-e2e-password";

async function authFetch(path, body, cookie) {
  return fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    // better-auth's CSRF check rejects a missing/null Origin; the server's own
    // origin is always trusted (it's the baseURL). Node fetch lets us set it.
    headers: { "Content-Type": "application/json", origin: SERVER_URL, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function signUpAndMintKey() {
  const signup = await authFetch("/api/auth/sign-up/email", { name: "Recon E2E", email, password });
  if (!signup.ok) throw new Error(`sign-up failed ${signup.status}: ${await signup.text()}`);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const created = await authFetch("/api/auth/api-key/create", { name: "recon-daemon" }, cookie);
  if (!created.ok) throw new Error(`api-key create failed ${created.status}: ${await created.text()}`);
  const { key } = await created.json();
  if (!key) throw new Error("api-key create returned no key");
  return key;
}

let apiKey;
const api = async (method, path, body) => {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

// ─── polling ───────────────────────────────────────────────────────────────
async function waitFor(label, fn, { timeoutMs = 30_000, everyMs = 1000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for: ${label} (last=${JSON.stringify(last)})`);
}

const stateLog = [];
async function assignmentState(id) {
  const rows = await api("GET", "/assignments");
  const a = rows.find((r) => r.id === id);
  const s = a?.observedState ?? "?";
  if (stateLog[stateLog.length - 1] !== s) {
    stateLog.push(s);
    log(`  observed_state → ${s} (chat_id=${a?.chatId ?? "null"})`);
  }
  return a;
}

// ─── run ──────────────────────────────────────────────────────────────────
let daemon;
let scratch;
let assignmentId;
try {
  // Reachability preflight.
  const health = await fetch(`${SERVER_URL}/health`).catch(() => null);
  if (!health) throw new Error(`server not reachable at ${SERVER_URL} — is compose up?`);
  const treeBefore = await cmuxTree();
  if (!treeBefore.includes("window")) throw new Error("cmux not reachable (empty tree)");
  log(`cmux reachable; server reachable at ${SERVER_URL}`);

  apiKey = await signUpAndMintKey();
  check("1. signed up + minted api key", Boolean(apiKey));

  // Start the V2 daemon (it registers this machine). Shares the "Hitch Dev"
  // store (HITCH_ROOT=1) so the installed claude hook's events land where the
  // daemon reads. Fast reconcile tick so running→waiting_input is prompt.
  daemon = spawn("npx", ["tsx", "daemon/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HITCH_SERVER_URL: SERVER_URL,
      HITCH_API_KEY: apiKey,
      HITCH_ROOT: "1",
      HITCH_RECONCILE_MS: "4000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (d) => appendFileSync(LOG, `[daemon] ${d}`));
  daemon.stderr.on("data", (d) => appendFileSync(LOG, `[daemon:err] ${d}`));

  // The daemon registers on boot → the machine row appears.
  const machine = await waitFor("machine registration", async () => {
    const rows = await api("GET", "/machines");
    return rows[0];
  });
  check("2. daemon registered its machine", Boolean(machine?.id), machine?.name);

  // Throwaway project (torn down with `compose down -v`). Its repoPath points at
  // the already-trusted repo root, NOT a fresh scratch dir: Claude Code blocks on
  // a "trust this folder?" prompt in an unseen directory, so no turn would ever
  // complete there. The delegated turn is read-only ("reply one word and stop"),
  // so pointing at the repo is safe; we still keep a scratch dir for symmetry.
  scratch = mkdtempSync(join(tmpdir(), "hitch-recon-scratch-"));
  const project = await api("POST", "/projects", { name: "Recon scratch", repoPath: REPO_ROOT, sortOrder: "m" });
  const task = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Reconciler smoke",
    body: "Reply with exactly one word and then stop. Do not do anything else.",
    sortOrder: "a0",
  });
  check("3. created scratch project (repoPath=tmp) + task");

  // Delegate: prompt null → the DAEMON builds the preamble (embeds the body).
  const assignment = await api("POST", "/assignments", {
    taskId: task.id,
    machineId: machine.id,
    harness: "claude",
    desiredState: "running",
  });
  assignmentId = assignment.id;
  check("4. posted assignment (desired=running, claude, prompt=null → daemon preamble)");

  // A real cmux tab opens with claude, and the assignment walks
  // pending → spawning → running.
  await waitFor("observed=spawning", async () => {
    const a = await assignmentState(assignmentId);
    return a && (a.observedState === "spawning" || a.observedState === "running") ? a : undefined;
  }, { timeoutMs: 45_000 });
  check("5. assignment reached spawning (daemon claimed + linked a chat before launch)");

  const running = await waitFor("observed=running", async () => {
    const a = await assignmentState(assignmentId);
    return a && (a.observedState === "running" || a.observedState === "waiting_input") ? a : undefined;
  }, { timeoutMs: 45_000 });
  check("6. assignment reached running (linked chat busy)", true, `chat_id=${running.chatId}`);

  // A server chat row was created by the daemon and linked.
  const chat = await api("GET", `/daemon/chats?machine_id=${machine.id}`).then((rows) =>
    rows.find((r) => r.id === running.chatId),
  );
  check("7. daemon created a linked server chat row", Boolean(chat), `harness=${chat?.harness}`);

  // A new cmux tab (surface) appeared for the spawn.
  const treeAfter = await cmuxTree();
  const newSurfaces =
    (treeAfter.match(/surface:\d+/g) || []).length - (treeBefore.match(/surface:\d+/g) || []).length;
  check("8. a new cmux tab opened for the spawn", newSurfaces >= 1, `Δsurfaces=${newSurfaces}`);

  // The claude turn finishes (one word) → the hook's turn.completed advances the
  // store row → the reconciler PATCHes waiting_input.
  await waitFor("observed=waiting_input", async () => {
    const a = await assignmentState(assignmentId);
    return a && a.observedState === "waiting_input" ? a : undefined;
  }, { timeoutMs: 120_000 });
  check("9. claude turn finished → waiting_input landed");

  // Stop intent (Decision 3): the client PATCHes desired=stopped; the reconciler
  // closes the tab and settles observed=done.
  await api("PATCH", `/assignments/${assignmentId}`, { desiredState: "stopped" });
  log("  patched desired=stopped");
  await waitFor("observed=done", async () => {
    const a = await assignmentState(assignmentId);
    return a && a.observedState === "done" ? a : undefined;
  }, { timeoutMs: 45_000 });
  check("10. desired=stopped → tab closed → observed=done");

  // The tab is gone (surface count back at/under the pre-spawn baseline).
  await sleep(1500);
  const treeClosed = await cmuxTree();
  const surfacesNow = (treeClosed.match(/surface:\d+/g) || []).length;
  const surfacesBefore = (treeBefore.match(/surface:\d+/g) || []).length;
  check("11. cmux tab was closed", surfacesNow <= surfacesBefore, `now=${surfacesNow} before=${surfacesBefore}`);

  log(`\nobserved_state transcript: ${stateLog.join(" → ")}`);
} catch (error) {
  check("run completed without throwing", false, String(error));
} finally {
  // Best-effort: ensure the tab is closed even on failure.
  if (assignmentId && apiKey) {
    await api("PATCH", `/assignments/${assignmentId}`, { desiredState: "stopped" }).catch(() => {});
    await sleep(3000);
  }
  if (daemon) daemon.kill("SIGINT");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  await sleep(500);
}

const failed = results.filter((r) => !r.pass).length;
log(`\nlog: ${LOG}`);
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
