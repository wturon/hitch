// Sections, end to end, through the real app: create one, file a task into it,
// collapse it, rename it, delete it — and prove the harness chip carries the
// agent status the row's NEEDS YOU / WORKING groups used to carry.
// DISPOSABLE, not a maintained suite — see ../../AGENTS.md.
//
// Two things here are only checkable against a running app:
//
//   1. Deleting a section must NOT delete its tasks. The FK is
//      `on delete set null`, so the tasks fall back to loose — but that is a
//      server guarantee the UI could still get wrong by optimistically
//      dropping the rows. Only a real round trip proves the todos survived.
//   2. The chip replaced the attention groups. A unit test can assert the
//      mapping; only the app can prove the old "Working" / "Needs input" text
//      is really gone from the row and that the chip advances with the daemon.
//
// The fake daemon (HITCH_FAKE_LAUNCH=1) drives a scripted spawn → working →
// waiting_input lifecycle, which is what makes the chip's states assertable
// without a real terminal.
//
// Prereqs:
//   - docker running (the script brings compose up unless SKIP_COMPOSE=1)
//   - the Vite dev renderer on :5173 (npm run dev:renderer)
//
// Run:
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-sections.mjs

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

// Exactly ONE daemon per machine — this script runs its own, so the app's must
// stand down or the two race for the same assignment and the run hangs at
// `spawning` with nothing in the log to explain it.
process.env.HITCH_DISABLE_APP_DAEMON = "1";

const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
process.env.HITCH_SERVER_URL = SERVER_URL;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-sections.log");
writeFileSync(LOG, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  console.log(m);
  appendFileSync(LOG, `${m}\n`);
};
const compose = (args) => {
  const res = spawnSync("docker", ["compose", ...args], { cwd: REPO_ROOT, stdio: "inherit" });
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
const email = `sections-${stamp}@e2e.local`;
const password = "hitch-e2e-password";

let daemon;
let scratch;
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

  const launched = await launchHitch({ profile: "v2-sections" });
  const { page, stateDir } = launched;
  cleanupApp = launched.cleanup;
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("Sections E2E");
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

  const project = await api("POST", "/projects", { name: "Sectioned", sortOrder: "a1" });
  await page.locator("[data-testid=v2-project-row]", { hasText: "Sectioned" }).click();
  const tasks = [];
  for (const [i, title] of ["Alpha task", "Beta task", "Gamma task"].entries()) {
    tasks.push(
      await api("POST", "/tasks", {
        projectId: project.id,
        title,
        body: "",
        sortOrder: `a${i + 1}`,
      }),
    );
  }
  const list = page.locator("[data-testid=v2-todos]");
  await page.locator("[data-testid=v2-task-row]", { hasText: "Alpha task" }).waitFor({ timeout: 20_000 });

  // ── the groups are gone ───────────────────────────────────────────────────
  check(
    "2. NEEDS YOU / WORKING / BACKLOG groups are gone",
    (await list.locator("[data-testid=v2-needs-you]").count()) === 0 &&
      (await list.locator("[data-testid=v2-working]").count()) === 0 &&
      (await list.locator("[data-testid=v2-backlog]").count()) === 0,
  );
  check(
    "3. a project with no sections renders one loose list",
    (await list.locator("[data-testid=v2-loose] [data-testid=v2-task-row]").count()) === 3,
  );

  // ── create a section THROUGH THE UI ──────────────────────────────────────
  await list.hover();
  const newSection = page.locator("[data-testid=v2-new-section]");
  await newSection.click();
  await page.getByLabel("Section name").fill("Launch blockers");
  await page.getByLabel("Section name").press("Enter");
  const created = await waitFor("the section to reach the server", async () => {
    const rows = await api("GET", `/sections?project_id=${project.id}`);
    return rows.find((s) => s.name === "Launch blockers");
  });
  check("4. + New section created it on the server", Boolean(created), created?.id);
  await page.locator("[data-testid=v2-section-header]", { hasText: "Launch blockers" }).waitFor({ timeout: 15_000 });
  check("5. and it renders as a section header");
  await shot("v2-sections-01-created");

  // ── file a task into it via Move to ▸ ────────────────────────────────────
  await page.locator("[data-testid=v2-task-row]", { hasText: "Beta task" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "Launch blockers", exact: true }).click();
  const moved = await waitFor("Beta task to be filed", async () => {
    const row = (await api("GET", `/tasks?project_id=${project.id}`)).find(
      (t) => t.title === "Beta task",
    );
    return row?.sectionId === created.id ? row : undefined;
  });
  check("6. Move to ▸ set sectionId on the server", moved.sectionId === created.id);

  const sectionEl = page.locator(`[data-testid=v2-section][data-section-id="${created.id}"]`);
  await waitFor("Beta task to render inside the section", async () =>
    (await sectionEl.locator("[data-testid=v2-task-row]", { hasText: "Beta task" }).count()) === 1 || undefined,
  );
  check("7. and the row moved under that section in the list");
  check(
    "8. leaving the other two loose",
    (await list.locator("[data-testid=v2-loose] [data-testid=v2-task-row]").count()) === 2,
  );

  // ── the section's own add-row files into it ──────────────────────────────
  await sectionEl.locator("[data-testid=v2-add-task]").click();
  await page.locator("[role=dialog] [contenteditable=true]").first().fill("Filed by the add row");
  await page.keyboard.press("Meta+Enter");
  const filed = await waitFor("the section capture to persist", async () => {
    const row = (await api("GET", `/tasks?project_id=${project.id}`)).find(
      (t) => t.title.includes("Filed by the add row"),
    );
    return row?.sectionId === created.id ? row : undefined;
  });
  check("9. a section's add-row captures INTO that section", filed.sectionId === created.id);
  await page.keyboard.press("Escape");

  // ── collapse hides the rows, keeps the count ─────────────────────────────
  const header = page.locator("[data-testid=v2-section-header]", { hasText: "Launch blockers" });
  await header.getByRole("button", { name: /Collapse/ }).click();
  await waitFor("the section to collapse", async () =>
    (await sectionEl.locator("[data-testid=v2-task-row]").count()) === 0 || undefined,
  );
  check("10. collapsing hides its rows");
  check("11. and the header still reports the count", (await header.innerText()).includes("2"));
  await shot("v2-sections-02-collapsed");
  await header.getByRole("button", { name: /Expand/ }).click();

  // ── rename through the ⋯ menu ────────────────────────────────────────────
  await header.hover();
  await header.getByRole("button", { name: /Section options/ }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Section name").fill("Renamed section");
  await page.getByLabel("Section name").press("Enter");
  const renamed = await waitFor("the rename to persist", async () => {
    const rows = await api("GET", `/sections?project_id=${project.id}`);
    return rows.find((s) => s.id === created.id && s.name === "Renamed section");
  });
  check("12. ⋯ → Rename persisted", renamed.name === "Renamed section");

  // ── delete keeps the todos ───────────────────────────────────────────────
  page.once("dialog", (d) => d.accept());
  const renamedHeader = page.locator("[data-testid=v2-section-header]", { hasText: "Renamed section" });
  await renamedHeader.hover();
  await renamedHeader.getByRole("button", { name: /Section options/ }).click();
  await page.getByRole("menuitem", { name: "Delete section" }).click();
  await waitFor("the section to be gone", async () => {
    const rows = await api("GET", `/sections?project_id=${project.id}`);
    return rows.every((s) => s.id !== created.id) || undefined;
  });
  check("13. ⋯ → Delete section removed it");

  const survivors = await api("GET", `/tasks?project_id=${project.id}`);
  check(
    "14. its todos SURVIVED and fell back to loose",
    survivors.length === 4 && survivors.every((t) => t.sectionId === null),
    `${survivors.length} tasks, sectionIds=${[...new Set(survivors.map((t) => t.sectionId))]}`,
  );
  await waitFor("all four rows to render loose", async () =>
    (await list.locator("[data-testid=v2-loose] [data-testid=v2-task-row]").count()) === 4 || undefined,
  );
  check("15. and the list shows all four again");

  // ── the chip carries agent status ────────────────────────────────────────
  scratch = mkdtempSync(join(tmpdir(), "hitch-sections-daemon-"));
  daemon = spawn("npx", ["tsx", "daemon/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HITCH_SERVER_URL: SERVER_URL,
      HITCH_API_KEY: creds.apiKey,
      HITCH_FAKE_LAUNCH: "1",
      HITCH_FAKE_LAUNCH_DELAY_MS: "4000",
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
  const machine = await waitFor(
    "the daemon to register a machine",
    async () => {
      const rows = await api("GET", "/machines");
      return rows[0];
    },
    { timeoutMs: 40_000 },
  );

  const alpha = survivors.find((t) => t.title === "Alpha task");
  await api("POST", "/assignments", {
    taskId: alpha.id,
    machineId: machine.id,
    harness: "claude",
  });

  const alphaRow = page.locator("[data-testid=v2-task-row]", { hasText: "Alpha task" });
  const chip = alphaRow.locator("[data-testid=v2-harness-chip]");
  await waitFor(
    "the chip to show working",
    async () =>
      (await chip.getAttribute("data-chip-state").catch(() => null)) === "working" ||
      undefined,
    { timeoutMs: 30_000 },
  );
  check("16. a delegated row grows a WORKING chip");
  await shot("v2-sections-03-chip-working");

  check(
    "17. and the row carries no status TEXT any more",
    !/Working|Needs input|Mark reviewed/.test(await alphaRow.innerText()),
    JSON.stringify(await alphaRow.innerText()),
  );

  await waitFor(
    "the chip to advance to needs-you",
    async () =>
      (await chip.getAttribute("data-chip-state").catch(() => null)) === "needs-you" ||
      undefined,
    { timeoutMs: 30_000 },
  );
  check("18. the chip advances to NEEDS-YOU when the turn completes");
  await shot("v2-sections-04-chip-needs-you");

  check(
    "19. rows without an agent still render a chip-less slot",
    (await list.locator("[data-testid=v2-harness-chip]").count()) === 1,
  );
} catch (error) {
  failed++;
  log(`FAIL  threw — ${error?.stack ?? error}`);
} finally {
  if (daemon) daemon.kill("SIGINT");
  await sleep(500);
  if (daemon && !daemon.killed) daemon.kill("SIGKILL");
  await cleanupApp().catch(() => {});
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  log(`\n${passed} passed, ${failed} failed  (log: ${LOG})`);
  if (daemonOut && failed) log(`\n--- daemon tail ---\n${daemonOut.slice(-2000)}`);
  process.exit(failed ? 1 : 0);
}
