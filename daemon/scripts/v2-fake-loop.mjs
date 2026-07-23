// HEADLESS loop verification for M4 PR 4 (fake-launch mode). DISPOSABLE — not a
// maintained test. Drives the V2 daemon in HITCH_FAKE_LAUNCH mode against the
// compose stack with NO cmux and NO agent binary, and asserts the full
// desired/observed loop runs on the SERVER with zero real spawns:
//
//   POST assignment (desired=running, claude) →
//     assignment walks pending → spawning → running →
//     the fake turn completes → waiting_input →
//   PATCH desired=stopped → observed → done.
//
// It also asserts the server `chats` row the daemon created walks
// busy → waiting_input → dead alongside the assignment.
//
// Because the fake launcher writes NO transcript/thread/pidfile, the observer's
// dead-process heal can never touch these sessions (heal-proof by construction).
//
// Prereq:  docker compose up -d --build   (server on :3010)
// Run:     node daemon/scripts/v2-fake-loop.mjs
//          (or HARNESS=codex node daemon/scripts/v2-fake-loop.mjs)
//
// The daemon runs with an ISOLATED store (HITCH_APP_SUPPORT_DIR=<scratch>) so it
// never touches the real chat-lifecycle.sqlite. Cleanup is automatic (kills the
// daemon, removes the scratch dir). `docker compose down -v` is left to the caller.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HARNESS = process.env.HARNESS === "codex" ? "codex" : "claude";
const LOG = join(tmpdir(), `v2-fake-loop-${Date.now()}.log`);
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

// ─── auth ────────────────────────────────────────────────────────────────────
const email = `fakeloop-${Date.now()}@example.com`;
const password = "hitch-e2e-password";

async function authFetch(path, body, cookie) {
  return fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: SERVER_URL, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function signUpAndMintKey() {
  const signup = await authFetch("/api/auth/sign-up/email", { name: "Fake Loop", email, password });
  if (!signup.ok) throw new Error(`sign-up failed ${signup.status}: ${await signup.text()}`);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const created = await authFetch("/api/auth/api-key/create", { name: "fake-loop-daemon" }, cookie);
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
async function waitFor(label, fn, { timeoutMs = 30_000, everyMs = 150 } = {}) {
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

const chatStateLog = [];
async function chatStatus(machineId, chatId) {
  if (!chatId) return undefined;
  const rows = await api("GET", `/daemon/chats?machine_id=${machineId}`);
  const c = rows.find((r) => r.id === chatId);
  const s = c?.status ?? "?";
  if (chatStateLog[chatStateLog.length - 1] !== s) {
    chatStateLog.push(s);
    log(`  chat.status → ${s}`);
  }
  return c;
}

// ─── run ──────────────────────────────────────────────────────────────────
let daemon;
let scratch;
let assignmentId;
try {
  const health = await fetch(`${SERVER_URL}/health`).catch(() => null);
  if (!health) throw new Error(`server not reachable at ${SERVER_URL} — is compose up?`);
  log(`server reachable at ${SERVER_URL}; harness=${HARNESS}; FAKE_LAUNCH=1 (no cmux)`);

  apiKey = await signUpAndMintKey();
  check("1. signed up + minted api key", Boolean(apiKey));

  // Isolated store dir so the fake daemon never touches the real sqlite. No
  // HITCH_ROOT and no real cmux — this is fully headless.
  scratch = mkdtempSync(join(tmpdir(), "hitch-fake-loop-"));
  daemon = spawn("npx", ["tsx", "daemon/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HITCH_SERVER_URL: SERVER_URL,
      HITCH_API_KEY: apiKey,
      HITCH_FAKE_LAUNCH: "1",
      // Delay the fake turn past a couple of reconcile ticks so `spawning` and
      // `running` are each observable before the row folds to `waiting`.
      HITCH_FAKE_LAUNCH_DELAY_MS: "2500",
      HITCH_APP_SUPPORT_DIR: scratch,
      HITCH_RECONCILE_MS: "800",
      HITCH_HEARTBEAT_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOut = "";
  daemon.stdout.on("data", (d) => {
    daemonOut += d;
    appendFileSync(LOG, `[daemon] ${d}`);
  });
  daemon.stderr.on("data", (d) => {
    daemonOut += d;
    appendFileSync(LOG, `[daemon:err] ${d}`);
  });

  const machine = await waitFor("machine registration", async () => {
    const rows = await api("GET", "/machines");
    return rows[0];
  });
  check("2. daemon registered its machine", Boolean(machine?.id), machine?.name);

  const project = await api("POST", "/projects", { name: "Fake loop", repoPath: REPO_ROOT, sortOrder: "m" });
  const task = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Fake reconciler loop",
    body: "A headless fake-launch task.",
    sortOrder: "a0",
  });
  check("3. created project + task");

  const assignment = await api("POST", "/assignments", {
    taskId: task.id,
    machineId: machine.id,
    harness: HARNESS,
    desiredState: "running",
  });
  assignmentId = assignment.id;
  check(`4. posted assignment (desired=running, ${HARNESS}, prompt=null → daemon preamble)`);

  await waitFor("observed=spawning", async () => {
    const a = await assignmentState(assignmentId);
    return a && ["spawning", "running", "waiting_input"].includes(a.observedState) ? a : undefined;
  }, { timeoutMs: 20_000 });
  check("5. assignment reached spawning (daemon claimed + linked a chat, no spawn)");

  const running = await waitFor("observed=running", async () => {
    const a = await assignmentState(assignmentId);
    return a && ["running", "waiting_input"].includes(a.observedState) ? a : undefined;
  }, { timeoutMs: 20_000 });
  check("6. assignment reached running (linked chat busy)", true, `chat_id=${running.chatId}`);

  const chat = await api("GET", `/daemon/chats?machine_id=${machine.id}`).then((rows) =>
    rows.find((r) => r.id === running.chatId),
  );
  check("7. daemon created a linked server chat row", Boolean(chat), `harness=${chat?.harness}`);
  await chatStatus(machine.id, running.chatId); // seed chat state log

  await waitFor("observed=waiting_input", async () => {
    const a = await assignmentState(assignmentId);
    await chatStatus(machine.id, a?.chatId);
    return a && a.observedState === "waiting_input" ? a : undefined;
  }, { timeoutMs: 30_000 });
  check("8. fake turn completed → waiting_input landed (zero real spawns)");
  check("9. server chat row reached waiting_input", chatStateLog.includes("waiting_input"),
    `chat.status transcript: ${chatStateLog.join(" → ")}`);

  await api("PATCH", `/assignments/${assignmentId}`, { desiredState: "stopped" });
  log("  patched desired=stopped");
  await waitFor("observed=done", async () => {
    const a = await assignmentState(assignmentId);
    await chatStatus(machine.id, a?.chatId);
    return a && a.observedState === "done" ? a : undefined;
  }, { timeoutMs: 20_000 });
  check("10. desired=stopped → observed=done");

  // The server chat settled to dead via the fake session.ended.
  await waitFor("chat.status=dead", async () => {
    const c = await chatStatus(machine.id, running.chatId);
    return c && c.status === "dead" ? c : undefined;
  }, { timeoutMs: 15_000 });
  check("11. server chat row reached dead", chatStateLog.includes("dead"),
    `chat.status transcript: ${chatStateLog.join(" → ")}`);

  // `spawning` is written by the daemon (onLinked → patchAssignment "spawning")
  // but collapses to `running` within one serialized reconcile burst, so a
  // polling client can't reliably capture it. Prove it ran from the daemon's own
  // log line instead of racing the poll.
  const spawnLogged = /reconciler spawning (claude|codex) for assignment/.test(daemonOut);
  check("12. daemon executed the spawning claim (observed_state=spawning was written)",
    spawnLogged, spawnLogged ? "logged 'reconciler spawning'" : "no spawn log line");

  // The polled transcript must be an in-order walk toward done that visits the
  // key milestones. (spawning may be elided per above; never out of order.)
  const order = ["pending", "spawning", "running", "waiting_input", "done"];
  let cursor = -1;
  let ordered = true;
  for (const s of stateLog) {
    const idx = order.indexOf(s);
    if (idx <= cursor) { ordered = false; break; }
    cursor = idx;
  }
  const milestones = ["running", "waiting_input", "done"].every((s) => stateLog.includes(s));
  check("13. observed_state walked in order through running→waiting_input→done",
    ordered && milestones, stateLog.join(" → "));

  log(`\nobserved_state transcript: ${stateLog.join(" → ")}`);
  log(`chat.status transcript:    ${chatStateLog.join(" → ")}`);
} catch (error) {
  check("run completed without throwing", false, String(error));
} finally {
  if (assignmentId && apiKey) {
    await api("PATCH", `/assignments/${assignmentId}`, { desiredState: "stopped" }).catch(() => {});
    await sleep(1500);
  }
  if (daemon) daemon.kill("SIGINT");
  await sleep(500);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
log(`\nlog: ${LOG}`);
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
