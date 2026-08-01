// Throwaway check for "Link a chat". DISPOSABLE — see ../../AGENTS.md.
//
//   docker compose up -d --build            # server on :3010
//   npm run dev:renderer                    # vite on :5173
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-link-chat.mjs
//
// Drives: sign-up → PUT a chat snapshot of chats NOBODY LAUNCHED FROM HITCH →
// open a task → Link a chat → pick one → assert the lane adopts it, that the
// row is honest about not being openable, and that the second attempt on a
// chat already serving another task shows the server's 409 prose.

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

const email = `link-${Date.now()}@example.com`;
const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();

const { app, page, stateDir, cleanup } = await launchHitch({ profile: "link-chat" });
try {
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("Link User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("hitch-e2e-password");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page
    .locator("[data-testid=v2-project-row]", { hasText: "Inbox" })
    .waitFor({ timeout: 30_000 });
  check("1. signed up against the compose server");

  const creds = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8")).hitchServer;
  const api = async (method, path, body) => {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  };

  const machine = await api("POST", "/daemon/machines", {
    name: "orinoco",
    daemonVersion: "0.0.1-link",
  });
  const project = await api("POST", "/projects", { name: "Hitch", sortOrder: "m" });
  const task = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Manually link a detected chat to a task",
    sortOrder: "a0",
  });
  const otherTask = await api("POST", "/tasks", {
    projectId: project.id,
    title: "Sections v1",
    sortOrder: "a1",
  });

  // Chats with NO handle: sessions the user started by hand, which Hitch can
  // see and has never launched. This is the entire point of the feature.
  await api("PUT", `/daemon/machines/${machine.id}/chat-snapshot`, {
    observedAt: iso(),
    window: { since: iso(24 * 3600), cap: 60, truncated: false },
    chats: [
      {
        harness: "claude",
        sessionId: "0f2ca91b-7c4d-4c1a-9d1f-aa11bb22cc33",
        cwd: "/Users/w/code/hitch",
        process: { pid: 48213, startedAt: 1753426442 },
        existence: "running",
        activity: "working",
        source: "claude-pidfile",
        projectId: project.id,
        title: "Chase the EBADF spawn failures",
      },
      {
        harness: "codex",
        sessionId: "01930f2c-a91b-7000-8000-000000000002",
        cwd: "/Users/w/code/hitch/server",
        process: { pid: 51022, startedAt: 1753426501 },
        existence: "running",
        activity: "idle",
        source: "codex-sqlite",
        projectId: project.id,
        title: "Snapshot endpoint review",
      },
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000003",
        cwd: "/Users/w/code/scratch",
        existence: "dormant",
        activity: "unknown",
        source: "claude-dormant",
        title: "Yesterday's scratch session",
      },
      // Dead — must NEVER be offered (mirrors the server's attachable rule).
      {
        harness: "codex",
        sessionId: "01930f2c-a91b-7000-8000-000000000004",
        cwd: "/Users/w/code/hitch",
        existence: "running",
        activity: "idle",
        source: "codex-sqlite",
        title: "Will be swept dead",
      },
    ],
    events: [],
  });
  // Second tick without the last chat → the server sweeps it dead.
  await api("PUT", `/daemon/machines/${machine.id}/chat-snapshot`, {
    observedAt: iso(),
    window: { since: iso(24 * 3600), cap: 60, truncated: false },
    chats: [
      {
        harness: "claude",
        sessionId: "0f2ca91b-7c4d-4c1a-9d1f-aa11bb22cc33",
        cwd: "/Users/w/code/hitch",
        process: { pid: 48213, startedAt: 1753426442 },
        existence: "running",
        activity: "working",
        source: "claude-pidfile",
        projectId: project.id,
        title: "Chase the EBADF spawn failures",
      },
      {
        harness: "codex",
        sessionId: "01930f2c-a91b-7000-8000-000000000002",
        cwd: "/Users/w/code/hitch/server",
        process: { pid: 51022, startedAt: 1753426501 },
        existence: "running",
        activity: "idle",
        source: "codex-sqlite",
        projectId: project.id,
        title: "Snapshot endpoint review",
      },
      {
        harness: "claude",
        sessionId: "01930f2c-a91b-7000-8000-000000000003",
        cwd: "/Users/w/code/scratch",
        existence: "dormant",
        activity: "unknown",
        source: "claude-dormant",
        title: "Yesterday's scratch session",
      },
    ],
    events: [],
  });
  check("2. seeded 3 live handle-less chats + 1 swept dead");

  // Park one of them on ANOTHER task, so the picker has a disabled row and the
  // 409 path is reachable.
  const taken = await fetch(`${SERVER_URL}/assignments/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
    body: JSON.stringify({
      taskId: otherTask.id,
      harness: "claude",
      sessionId: "01930f2c-a91b-7000-8000-000000000003",
      machineId: machine.id,
    }),
  });
  check("3. parked the scratch chat on another task", taken.status === 201, `status ${taken.status}`);

  // Open the task.
  await page.locator("[data-testid=v2-project-row]", { hasText: "Hitch" }).click();
  await page
    .locator("[data-testid=v2-task-row]", { hasText: "Manually link a detected chat" })
    .click();
  await page.getByRole("button", { name: "Link a chat" }).waitFor({ timeout: 15_000 });
  check("4. the delegate band offers 'Link a chat' next to the composer");

  await page.getByRole("button", { name: "Link a chat" }).click();
  await page.getByPlaceholder("Search chats on this machine…").waitFor({ timeout: 10_000 });
  const optionText = await page.locator("[cmdk-item]").allInnerTexts();
  // Let the popup's open animation finish, else the shot catches it mid-fade
  // and every surface behind it bleeds through.
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "link-picker-open.png") });

  const offered = optionText.join(" | ");
  check(
    "5. offers the live chats and never the dead one",
    offered.includes("Chase the EBADF") &&
      offered.includes("Snapshot endpoint review") &&
      !offered.includes("Will be swept dead"),
    offered,
  );
  check(
    "6. shows the already-taken chat, disabled, naming its task",
    offered.includes("Yesterday's scratch session") && offered.includes("Sections v1"),
    offered,
  );
  check(
    "7. groups by project",
    (await page.locator("[cmdk-group-heading]").allInnerTexts()).join("|").includes("In this project"),
  );

  // Link the working one.
  await page.locator("[cmdk-item]", { hasText: "Chase the EBADF" }).click();
  const laneRow = page.locator("[data-testid=v2-chat-lane-row]");
  await laneRow.first().waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(SHOTS, "link-lane-after.png") });
  const rowText = await laneRow.first().innerText();
  check("8. the lane adopted the chat", rowText.includes("Claude"), rowText);
  check(
    "9. the row admits Hitch didn't launch it",
    rowText.includes("linked from terminal"),
    rowText,
  );

  // The honesty pass: Open chat disabled, Stop reads Unlink.
  const openBtn = laneRow.first().getByRole("button", { name: "Open chat" });
  check("10. Open chat is disabled for a chat with no handle", await openBtn.isDisabled());
  check(
    "11. Stop reads 'Unlink' — it can only let go, not close",
    (await laneRow.first().getByRole("button", { name: "Unlink" }).count()) === 1,
    rowText,
  );

  // The 409: try to link the chat that's already on another task by clicking a
  // disabled row (should be inert), then verify the disabled state holds.
  await page.getByRole("button", { name: "Link a chat" }).click();
  await page.getByPlaceholder("Search chats on this machine…").waitFor({ timeout: 10_000 });
  const disabledRow = page.locator("[cmdk-item][data-disabled=true]", {
    hasText: "Yesterday's scratch session",
  });
  check("12. the taken chat is inert, not just styled", (await disabledRow.count()) === 1);
  // And the linked one is gone from the list — it serves THIS task now.
  const second = (await page.locator("[cmdk-item]").allInnerTexts()).join(" | ");
  check(
    "13. a chat already on this task drops out of the picker",
    !second.includes("Chase the EBADF"),
    second,
  );
  await page.screenshot({ path: join(SHOTS, "link-picker-second.png") });
  await page.keyboard.press("Escape");
} catch (error) {
  check(`crashed: ${String(error)}`, false);
  await page.screenshot({ path: join(SHOTS, "link-crash.png") }).catch(() => {});
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await cleanup().catch(() => {});
  await app.close().catch(() => {});
  process.exit(failed.length === 0 ? 0 : 1);
}
