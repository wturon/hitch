// Throwaway check for the Chat Inspector window. DISPOSABLE — see ../../AGENTS.md.
//
//   docker compose up -d --build            # server on :3010
//   npm run dev:renderer                    # vite on :5173
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-chat-inspector.mjs
//
// Drives: sign-up → PUT real chat snapshots (running/dormant/pending/blocked +
// a swept-dead row + a truncated tick) straight at the daemon endpoint → open
// the Inspector with ⌘⌥I → assert the health strip, the table, the filters and
// the row drawer render off the server read.

import { mkdirSync, readFileSync } from "node:fs";
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

const results = [];
const check = (name, pass = true, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const email = `inspector-${Date.now()}@example.com`;
const password = "hitch-e2e-password";
const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();

const { app, page, stateDir, cleanup } = await launchHitch({ profile: "chat-inspector" });
try {
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("Inspector User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("[data-testid=v2-project-row]", { hasText: "Inbox" }).waitFor({ timeout: 30_000 });
  check("1. signed up against the compose server");

  const creds = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8")).hitchServer;
  const api = async (method, path, body) => {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
    return await response.json();
  };

  // A machine of our own, so the app's real daemon (which registers its own)
  // can't make the assertions below flaky.
  const machine = await api("POST", "/daemon/machines", {
    name: "orinoco",
    daemonVersion: "0.0.1-inspector",
  });
  // A machine that has never PUT a snapshot — the loud "no coverage at all"
  // state the health strip exists to make impossible to miss.
  await api("POST", "/daemon/machines", { name: "silent-box", daemonVersion: "0.0.1-silent" });
  const project = await api("POST", "/projects", { name: "Hitch", sortOrder: "m" });
  const task = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Build the Chat Inspector",
    sortOrder: "a0",
  });
  const assignment = await api("POST", "/assignments", {
    taskId: task.id,
    machineId: machine.id,
    harness: "claude",
  });

  const window24h = { since: iso(24 * 3600), cap: 60, truncated: false };
  const put = (body) => api("PUT", `/daemon/machines/${machine.id}/chat-snapshot`, body);

  // Tick 1: a working chat, a dormant one, a pending one, and one that will be
  // swept dead on the next tick.
  await put({
    observedAt: iso(),
    window: window24h,
    chats: [
      {
        harness: "claude",
        sessionId: "0f2ca91b-7c4d-4c1a-9d1f-aa11bb22cc33",
        cwd: "/Users/w/code/hitch",
        process: { pid: 48213, startedAt: 1753426442 },
        existence: "running",
        activity: "working",
        source: "claude-pidfile",
        evidence: { self: "busy", mtimeAge: 1.2, cursor: 84213, dev: 16777232, ino: 90210 },
        projectId: project.id,
        handle: { cmux: "surface:7" },
        title: "Chat Inspector — build the window",
      },
      {
        harness: "codex",
        sessionId: "01930f2c-a91b-7000-8000-000000000002",
        cwd: "/Users/w/code/hitch/server",
        process: { pid: 51022, startedAt: 1753426501 },
        existence: "running",
        activity: "idle",
        source: "codex-sqlite",
        evidence: { threadSource: "state_5.sqlite", mtimeAge: 42.9 },
        task: assignment.id,
        title: "Snapshot endpoint review",
      },
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000003",
        cwd: "/Users/w/code/scratch",
        existence: "dormant",
        activity: "unknown",
        source: "claude-dormant",
        evidence: { mtimeAge: 8123.4, size: 220144 },
        title: "Yesterday's scratch session",
      },
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000004",
        cwd: "/Users/w/code/hitch",
        existence: "pending",
        activity: "unknown",
        source: "claude-pidfile",
        evidence: { launchedAt: iso(3) },
        title: "Just launched, not yet bound",
      },
      {
        harness: "codex",
        sessionId: "01930f2c-a91b-7000-8000-000000000005",
        cwd: "/Users/w/code/hitch/daemon",
        process: { pid: 44001, startedAt: 1753420000 },
        existence: "running",
        activity: "working",
        source: "codex-rollout",
        evidence: { marker: "turn.started", mtimeAge: 0.4 },
        title: "About to die",
      },
    ],
    events: [],
  });

  // Tick 2: the blocked chat raises a permission, and "About to die" is absent
  // — absence IS the heal path, so it should read dead.
  await put({
    observedAt: iso(),
    window: window24h,
    chats: [
      {
        harness: "claude",
        sessionId: "0f2ca91b-7c4d-4c1a-9d1f-aa11bb22cc33",
        cwd: "/Users/w/code/hitch",
        process: { pid: 48213, startedAt: 1753426442 },
        existence: "running",
        activity: "working",
        source: "claude-pidfile",
        evidence: { self: "busy", mtimeAge: 0.3, cursor: 91002, dev: 16777232, ino: 90210 },
        projectId: project.id,
        handle: { cmux: "surface:7" },
      },
      {
        harness: "codex",
        sessionId: "01930f2c-a91b-7000-8000-000000000002",
        cwd: "/Users/w/code/hitch/server",
        process: { pid: 51022, startedAt: 1753426501 },
        existence: "running",
        activity: "idle",
        source: "codex-sqlite",
        evidence: { threadSource: "state_5.sqlite", mtimeAge: 51.0 },
        task: assignment.id,
      },
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000003",
        cwd: "/Users/w/code/scratch",
        existence: "dormant",
        activity: "unknown",
        source: "claude-dormant",
        evidence: { mtimeAge: 8190.1, size: 220144 },
      },
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000004",
        cwd: "/Users/w/code/hitch",
        existence: "pending",
        activity: "unknown",
        source: "claude-pidfile",
        evidence: { launchedAt: iso(9) },
      },
    ],
    events: [
      { sessionId: "0f2ca91b-7c4d-4c1a-9d1f-aa11bb22cc33", harness: "claude", kind: "turn.started", at: iso(90) },
      {
        sessionId: "0f2ca91b-7c4d-4c1a-9d1f-aa11bb22cc33",
        harness: "claude",
        kind: "block.permission",
        at: iso(4),
        payload: { tool: "Bash", command: "rm -rf node_modules" },
      },
    ],
  });
  check("2. two real snapshot ticks landed (5 chats, one swept dead, one blocked)");

  // Bind the assignment so one row shows a task attachment.
  await api("PATCH", `/daemon/assignments/${assignment.id}`, {
    chatId: (await api("GET", `/chats?machine_id=${machine.id}`)).find(
      (c) => c.sessionId === "01930f2c-a91b-7000-8000-000000000002",
    ).id,
  });

  // --- open the Inspector the way a human does: ⌘⌥I ------------------------
  // NOT page.keyboard.press: Playwright dispatches keys over CDP, which does
  // not traverse the native input path, so Electron's `before-input-event`
  // (where the accelerator lives) never fires. sendInputEvent does traverse
  // it — verified: the handler sees {key:"i", code:"KeyI", meta, alt}.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "i",
      modifiers: ["meta", "alt"],
    });
  });
  const inspector = await app.waitForEvent("window", { timeout: 15_000 });
  await inspector.waitForLoadState("domcontentloaded");
  check("3. ⌘⌥I opened a second BrowserWindow");

  const url = inspector.url();
  check("4. the second window loads the SAME bundle with ?view=inspector", url.includes("view=inspector"), url);

  await inspector.locator("[data-testid=inspector-machine-health]").first().waitFor({ timeout: 20_000 });
  const rows = inspector.locator("[data-testid=inspector-chat-row]");
  await rows.first().waitFor({ timeout: 20_000 });
  check("5. the health strip and the table rendered off GET /chats");

  const health = await inspector
    .locator("[data-testid=inspector-machine-health]", { hasText: "orinoco" })
    .innerText();
  check(
    "6. health strip shows machine, window, cap, coverage and in-window count",
    health.includes("orinoco") && health.includes("complete") && health.includes("60") && health.includes("4 / 5"),
    health.replace(/\n/g, " | "),
  );

  const silent = inspector.locator('[data-testid=inspector-machine-health][data-health="never"]');
  await silent.waitFor({ timeout: 10_000 });
  check(
    "6b. a machine that has never snapshotted gets the loud alarm treatment",
    (await silent.innerText()).includes("no snapshot"),
  );

  const rowCount = await rows.count();
  check("7. every chat on the machine is listed", rowCount >= 5, `rows=${rowCount}`);
  const dead = await inspector.locator('[data-testid=inspector-chat-row][data-status="dead"]').count();
  check("8. the chat absent from tick 2 reads dead", dead === 1, `dead=${dead}`);
  const waiting = await inspector
    .locator('[data-testid=inspector-chat-row][data-status="waiting_input"]')
    .count();
  check("9. the relayed block.permission drove a waiting row", waiting === 1, `waiting=${waiting}`);

  await inspector.screenshot({ path: join(SHOTS, "inspector-01-table.png") });

  // Filters
  await inspector.locator("[data-testid=inspector-filter-blocked]").click();
  await inspector.waitForTimeout(200);
  check(
    "10. the blocked filter narrows to the blocked chat",
    (await rows.count()) === 1,
    `rows=${await rows.count()}`,
  );
  await inspector.screenshot({ path: join(SHOTS, "inspector-02-blocked.png") });

  await inspector.locator("[data-testid=inspector-filter-unattached]").click();
  await inspector.waitForTimeout(200);
  const unattached = await rows.count();
  check("11. the unattached filter narrows too", unattached > 0 && unattached < rowCount, `rows=${unattached}`);

  await inspector.locator("[data-testid=inspector-filter-all]").click();
  await inspector.waitForTimeout(200);

  // Row drawer
  await rows.first().click();
  await inspector.locator("[data-testid=inspector-drawer]").waitFor({ timeout: 10_000 });
  // The event tail is a lazy second query — wait for it rather than racing it.
  await inspector
    .locator("[data-testid=inspector-drawer]")
    .getByText("block.permission")
    .waitFor({ timeout: 10_000 });
  const drawer = await inspector.locator("[data-testid=inspector-drawer]").innerText();
  check(
    "12. the drawer shows evidence key-values and the relayed event tail",
    drawer.includes("claude-pidfile") && drawer.includes("48213") && drawer.includes("block.permission"),
    drawer.replace(/\n/g, " | ").slice(0, 400),
  );
  await inspector.screenshot({ path: join(SHOTS, "inspector-03-drawer.png") });

  // Realtime: a third tick, no interaction — the WS invalidation must reach
  // the SECOND window (main broadcasts to every window, not just the first).
  await put({
    observedAt: iso(),
    window: { since: iso(24 * 3600), cap: 40, truncated: true },
    chats: [
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000006",
        cwd: "/Users/w/code/hitch/desktop",
        process: { pid: 60001, startedAt: 1753430000 },
        existence: "running",
        activity: "working",
        source: "claude-pidfile",
        evidence: { self: "busy", mtimeAge: 0.1 },
        title: "Arrived over the WebSocket",
      },
    ],
    events: [],
  });
  await inspector
    .locator("[data-testid=inspector-chat-row]", { hasText: "Arrived over the WebSocket" })
    .waitFor({ timeout: 15_000 });
  check("13. a new chat appears in the Inspector with no interaction (WS → second window)");
  await inspector
    .locator("[data-testid=inspector-machine-health]", { hasText: "partial" })
    .waitFor({ timeout: 10_000 });
  check("14. a truncated tick flips coverage to a loud 'partial'");
  await inspector.screenshot({ path: join(SHOTS, "inspector-04-partial.png") });

  // Dark register.
  await inspector.evaluate(() => document.documentElement.classList.add("dark"));
  await inspector.waitForTimeout(300);
  await inspector.screenshot({ path: join(SHOTS, "inspector-05-dark.png") });
  check("15. dark register renders (screenshot)");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "inspector-99-error.png") }).catch(() => {});
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
console.log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
