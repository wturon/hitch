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
  // Base UI submenus open on hover and close again the moment the pointer
  // strays, which under a synthetic mouse is a coin flip — so re-open the whole
  // menu and try again rather than trusting one pass.
  async function moveViaMenu(rowTitle, sectionName) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.keyboard.press("Escape");
      await sleep(200);
      await page
        .locator("[data-testid=v2-task-row]", { hasText: rowTitle })
        .click({ button: "right" });
      const moveTo = page.getByRole("menuitem", { name: "Move to" });
      if (!(await moveTo.waitFor({ timeout: 5000 }).then(() => true, () => false))) continue;
      await moveTo.hover();
      const item = page.getByRole("menuitem", { name: sectionName, exact: true });
      if (!(await item.waitFor({ timeout: 3000 }).then(() => true, () => false))) continue;
      await sleep(300);
      if (await item.click({ force: true, timeout: 5000 }).then(() => true, () => false)) return;
    }
    throw new Error(`could not move "${rowTitle}" into "${sectionName}" via the menu`);
  }
  await moveViaMenu("Beta task", "Launch blockers");
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
  // The capture dialog must be fully gone before the drag below — its overlay
  // swallows pointer events, and a drag that starts under it never begins.
  await page.locator("[role=dialog]").waitFor({ state: "hidden", timeout: 10_000 });

  // ── drag across sections ─────────────────────────────────────────────────
  // Two gestures, and the second only works if collision detection is a real
  // hit test: an empty section has no rows for a SortableContext to register,
  // so the ONLY droppable there is the container itself. A "nearest centre"
  // strategy never surfaces it — it returns every droppable sorted by distance,
  // so the container loses to a row in some other section — and the section
  // stays permanently unfillable by drag.
  const empty = await api("POST", "/sections", {
    projectId: project.id,
    name: "Empty section",
    sortOrder: "a5",
  });
  const emptyEl = page.locator(`[data-testid=v2-section][data-section-id="${empty.id}"]`);
  await emptyEl.waitFor({ timeout: 15_000 });

  // The dialog's overlay puts `pointer-events: none` on the body and clears it
  // only after its exit transition — which outlives the element being hidden.
  // A drag begun in that window never starts, and reads as a broken feature.
  await page.waitForFunction(
    () => getComputedStyle(document.body).pointerEvents !== "none",
    undefined,
    { timeout: 10_000 },
  );

  // Press, one short move to clear PointerSensor's 4px activation distance,
  // then one long move: dnd-kit only recomputes collisions on movement.
  // `target` is either absolute {x, y} or {dy} — a delta from the source's own
  // centre, resolved AFTER the source is re-measured. Absolute coordinates
  // captured before the call go stale the moment a prior drop re-renders the
  // list, and a stale target silently performs a different gesture than the one
  // the check describes.
  async function dragTo(source, target) {
    // Park the pointer away first, then approach: the row arms its drag from a
    // pointerdown, and pressing on a spot the pointer is already sitting on
    // (having never entered the row) doesn't reliably produce one.
    await page.mouse.move(1, 1);
    await sleep(150);
    const box = await source.boundingBox();
    // WHERE on the row you grab matters, not just how far you drag: dnd-kit
    // resolves `over` from the pointer, so grabbing near a row's top edge means
    // a few pixels of travel already puts the pointer outside it. `grabDy` is
    // an offset from the row's TOP; the default is its centre.
    const grabY = box.y + (target.grabDy ?? box.height / 2);
    const targetBox =
      target.dy === undefined ? target : { x: box.x + box.width / 2, y: grabY + target.dy };
    await page.mouse.move(box.x + box.width / 2, grabY, { steps: 4 });
    await sleep(150);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, grabY + 8, { steps: 3 });
    await page.mouse.move(targetBox.x, targetBox.y, { steps: 10 });
    await page.mouse.up();
  }
  const sectionOf = async (title) =>
    (await api("GET", `/tasks?project_id=${project.id}`)).find((t) => t.title === title)
      ?.sectionId ?? null;

  const gamma = page.locator("[data-testid=v2-task-row]", { hasText: "Gamma task" });
  const betaBox = await page
    .locator("[data-testid=v2-task-row]", { hasText: "Beta task" })
    .boundingBox();
  await dragTo(gamma, {
    x: betaBox.x + betaBox.width / 2,
    y: betaBox.y + betaBox.height / 2,
  });
  const ontoRow = await waitFor("Gamma to land in Launch blockers", async () =>
    (await sectionOf("Gamma task")) === created.id || undefined,
  ).catch(() => false);
  check("10. dropping a row onto a row in another section files it", ontoRow === true);

  // Aimed at the section's HEADER, not a padding strip: "put it in this
  // section" is the gesture, and the header is what people point at. That band
  // is outside the rows, so it only resolves to anything if the whole section
  // is the drop target.
  const headerBox = await emptyEl
    .locator("[data-testid=v2-section-header]")
    .boundingBox();
  await dragTo(gamma, {
    x: headerBox.x + headerBox.width / 2,
    y: headerBox.y + headerBox.height / 2,
  });
  const ontoEmpty = await waitFor("Gamma to land in the empty section", async () =>
    (await sectionOf("Gamma task")) === empty.id || undefined,
  ).catch(() => false);
  check("11. and dropping on an EMPTY section's header works too", ontoEmpty === true);
  await shot("v2-sections-03-dragged");

  // Dropping a row on its OWN section's header means "put this first" — the
  // band above the rows belongs to the container, and reading every container
  // drop as "append" sends the row to the bottom instead. The section is
  // tinted either way, so a wrong answer here looks exactly like a right one.
  await api("PATCH", `/tasks/${(await api("GET", `/tasks?project_id=${project.id}`)).find((t) => t.title === "Gamma task").id}`, {
    sectionId: created.id,
  });
  const blockers = page.locator(
    `[data-testid=v2-section][data-section-id="${created.id}"]`,
  );
  await waitFor("Gamma to render inside Launch blockers", async () =>
    (await blockers.locator("[data-testid=v2-task-row]", { hasText: "Gamma task" }).count()) === 1 ||
    undefined,
  );
  const titlesIn = async () =>
    (await blockers.locator("[data-testid=v2-task-row]").allInnerTexts()).map((t) =>
      t.split("\n")[0].trim(),
    );
  const before = await titlesIn();
  const lastTitle = before.at(-1);
  const blockersHeader = await blockers
    .locator("[data-testid=v2-section-header]")
    .boundingBox();
  await dragTo(
    blockers.locator("[data-testid=v2-task-row]", { hasText: lastTitle }),
    { x: blockersHeader.x + blockersHeader.width / 2, y: blockersHeader.y + blockersHeader.height / 2 },
  );
  const movedToTop = await waitFor("the dragged row to become first", async () =>
    (await titlesIn())[0] === lastTitle || undefined,
  ).catch(() => false);
  check(
    "12. dropping a row on its own section header puts it FIRST, not last",
    movedToTop === true,
    `before=${before.join(" | ")} after=${(await titlesIn()).join(" | ")}`,
  );

  // A SMALL upward nudge on a section's FIRST row. The pointer clears the row's
  // top edge and lands in the add-row band, so the drop resolves to the
  // container — but the row itself is barely moved. Measuring the dragged
  // rect instead of the pointer reads that as "you dragged less than half a
  // row, so you meant the bottom" and relocates the top row to the END of its
  // own section, from a 12px gesture with no undo.
  const nudgeBefore = await titlesIn();
  // Grabbed 6px below the row's top and nudged up 12: the POINTER is 6px above
  // the row (so the drop resolves to the container's band) while the row has
  // moved barely a quarter of its own height. Grabbing at the centre instead
  // would make the two thresholds coincide and the check prove nothing.
  await dragTo(
    blockers.locator("[data-testid=v2-task-row]", { hasText: nudgeBefore[0] }),
    { grabDy: 6, dy: -12 },
  );
  // Poll rather than sleep: a slow round trip on a bare sleep reads as "nothing
  // moved", which is exactly what this check calls a PASS.
  await waitFor("the nudge to settle", async () => {
    const now = await titlesIn();
    return now.length === nudgeBefore.length ? now : undefined;
  }).catch(() => []);
  await sleep(1200);
  const nudgeAfter = await titlesIn();
  check(
    "13. a small nudge on the first row does NOT fling it to the bottom",
    nudgeAfter[0] === nudgeBefore[0],
    `${nudgeBefore.join(" | ")} → ${nudgeAfter.join(" | ")}`,
  );

  // The same drop, with the list SCROLLING mid-drag. dnd-kit's `delta` is
  // scroll-adjusted while a frozen activator coordinate and a live
  // getBoundingClientRect are not, so any code that adds those two reads a drop
  // on a header as a drop past the last row once the list has moved under the
  // pointer. Auto-scroll does this on its own near the list's edges — no user
  // gesture needed — so it is not an exotic path.
  const filler = [];
  for (let i = 0; i < 22; i++) {
    filler.push(
      await api("POST", "/tasks", {
        projectId: project.id,
        title: `Filler ${String(i).padStart(2, "0")}`,
        body: "",
        sortOrder: `b${String(i).padStart(2, "0")}`,
      }),
    );
  }
  await waitFor("the list to grow past one screen", async () =>
    (await list.evaluate((el) => el.scrollHeight > el.clientHeight + 200)) || undefined,
  );
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await sleep(300);
  const scrollTarget = filler[0].title;
  const scrollRow = page.locator("[data-testid=v2-task-row]", { hasText: scrollTarget });
  await scrollRow.scrollIntoViewIfNeeded();
  await sleep(300);
  const grabBox = await scrollRow.boundingBox();
  await page.mouse.move(1, 1);
  await sleep(150);
  await page.mouse.move(grabBox.x + grabBox.width / 2, grabBox.y + 6, { steps: 4 });
  await sleep(150);
  await page.mouse.down();
  await page.mouse.move(grabBox.x + grabBox.width / 2, grabBox.y + 14, { steps: 3 });
  // Scroll UNDER the drag — DOWNWARD (scrollTop increasing), which is the sign
  // that makes a scroll-blind comparison read "below the last row". Scrolling
  // the other way makes the same bug produce the right answer by accident.
  await list.evaluate((el) => {
    el.scrollTop += 120;
  });
  await sleep(300);
  const movedHeader = await blockers
    .locator("[data-testid=v2-section-header]")
    .boundingBox();
  await page.mouse.move(
    movedHeader.x + movedHeader.width / 2,
    movedHeader.y + movedHeader.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  const scrolledOrder = await waitFor("the scrolled drop to land", async () => {
    const titles = await titlesIn();
    return titles.includes(scrollTarget) ? titles : undefined;
  }).catch(() => []);
  check(
    "14. a drop on a header still means TOP after the list scrolls mid-drag",
    scrolledOrder[0] === scrollTarget,
    scrolledOrder.slice(0, 4).join(" | "),
  );
  for (const task of filler) await api("DELETE", `/tasks/${task.id}`);
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await sleep(400);

  // The same gesture against a ONE-ROW section — the case a container-midpoint
  // test gets backwards, because the band above a single row extends past the
  // container's own midpoint.
  const solo = await api("POST", "/sections", {
    projectId: project.id,
    name: "Solo section",
    sortOrder: "a7",
  });
  const soloEl = page.locator(`[data-testid=v2-section][data-section-id="${solo.id}"]`);
  await soloEl.waitFor({ timeout: 15_000 });
  const [first, second] = await titlesIn();
  const soloRowId = (await api("GET", `/tasks?project_id=${project.id}`)).find(
    (t) => t.title === second,
  ).id;
  await api("PATCH", `/tasks/${soloRowId}`, { sectionId: solo.id });
  await waitFor("the solo section to hold exactly one row", async () =>
    (await soloEl.locator("[data-testid=v2-task-row]").count()) === 1 || undefined,
  );
  const soloAddRow = await soloEl.locator("[data-testid=v2-add-task]").boundingBox();
  // Aim at the BOTTOM of its add-row: below the container's midpoint, above its
  // only row. Intent is unambiguous; a midpoint test answers "bottom".
  await dragTo(
    page.locator("[data-testid=v2-task-row]", { hasText: first }),
    { x: soloAddRow.x + soloAddRow.width / 2, y: soloAddRow.y + soloAddRow.height - 3 },
  );
  const soloOrder = await waitFor("both rows to be in the solo section", async () => {
    const titles = (
      await soloEl.locator("[data-testid=v2-task-row]").allInnerTexts()
    ).map((t) => t.split("\n")[0].trim());
    return titles.length === 2 ? titles : undefined;
  }).catch(() => []);
  check(
    "15. dropping above a ONE-row section's row lands above it, not below",
    soloOrder[0] === first,
    soloOrder.join(" | "),
  );
  await api("PATCH", `/tasks/${soloRowId}`, { sectionId: created.id });
  await api("DELETE", `/sections/${solo.id}`);

  // Put it back and drop the scratch section, so the later counts hold.
  const gammaId = (await api("GET", `/tasks?project_id=${project.id}`)).find(
    (t) => t.title === "Gamma task",
  ).id;
  await api("PATCH", `/tasks/${gammaId}`, { sectionId: null, sortOrder: "a3" });
  await api("DELETE", `/sections/${empty.id}`);
  await waitFor("the scratch section to disappear", async () =>
    (await emptyEl.count()) === 0 || undefined,
  );

  // ── collapse hides the rows, keeps the count ─────────────────────────────
  const header = page.locator("[data-testid=v2-section-header]", { hasText: "Launch blockers" });
  await header.getByRole("button", { name: /Collapse/ }).click();
  await waitFor("the section to collapse", async () =>
    (await sectionEl.locator("[data-testid=v2-task-row]").count()) === 0 || undefined,
  );
  check("16. collapsing hides its rows");
  check("17. and the header still reports the count", (await header.innerText()).includes("2"));
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
  check("18. ⋯ → Rename persisted", renamed.name === "Renamed section");

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
  check("19. ⋯ → Delete section removed it");

  const survivors = await api("GET", `/tasks?project_id=${project.id}`);
  check(
    "20. its todos SURVIVED and fell back to loose",
    survivors.length === 4 && survivors.every((t) => t.sectionId === null),
    `${survivors.length} tasks, sectionIds=${[...new Set(survivors.map((t) => t.sectionId))]}`,
  );
  await waitFor("all four rows to render loose", async () =>
    (await list.locator("[data-testid=v2-loose] [data-testid=v2-task-row]").count()) === 4 || undefined,
  );
  check("21. and the list shows all four again");

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
  check("22. a delegated row grows a WORKING chip");
  await shot("v2-sections-03-chip-working");

  check(
    "23. and the row carries no status TEXT any more",
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
  check("24. the chip advances to NEEDS-YOU when the turn completes");
  await shot("v2-sections-04-chip-needs-you");

  check(
    "25. rows without an agent still render a chip-less slot",
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
