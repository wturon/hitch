import assert from "node:assert/strict";

import { createFocusHandler } from "../src/v2/focus.js";
import type { HitchClient } from "../src/v2/serverClient.js";

// The focus relay (M4 PR 6): a focus event carries the SERVER chat id; the
// handler resolves the chat's HANDLE — attachment 2, the nullable jsonb that
// replaced cmux_ref — into a session id + cwd, and drives the injected cmux
// focus. This smoke asserts that resolution: no server, no cmux.

const MACHINE = "machine-1";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as never;
}

// Minimal hono-client stand-in: only the two endpoints the handler touches.
function fakeClient(options: {
  chats: unknown[];
  projectsById: Record<string, { id: string; name: string }>;
  onChatsQuery?: (machineId: string) => void;
}): HitchClient {
  return {
    daemon: {
      chats: {
        $get: async (input: { query: { machine_id: string } }) => {
          options.onChatsQuery?.(input.query.machine_id);
          return jsonResponse(options.chats);
        },
      },
    },
    projects: {
      ":id": {
        $get: async (input: { param: { id: string } }) =>
          jsonResponse(options.projectsById[input.param.id] ?? { id: input.param.id, name: "" }),
      },
    },
  } as unknown as HitchClient;
}

const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(m),
  error: (m: string) => logs.push(`ERR ${m}`),
};

// ── happy path: resolves session/cwd/project and calls focus ─────────────────
{
  const focused: Array<{ sessionId: string; cwd?: string; projectId: string; projectName: string }> = [];
  let queriedMachine: string | null = null;
  const client = fakeClient({
    chats: [
      {
        id: "chat-1",
        projectId: "proj-1",
        sessionId: "session-abc",
        cwd: "/repo/path",
        handle: { kind: "cmux", sessionId: "session-abc", cwd: "/repo/path" },
      },
    ],
    projectsById: { "proj-1": { id: "proj-1", name: "My Project" } },
    onChatsQuery: (m) => (queriedMachine = m),
  });
  const handler = createFocusHandler({
    client,
    machineId: MACHINE,
    logger,
    focus: async (spec) => {
      focused.push({
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        projectId: spec.projectId,
        projectName: spec.projectName,
      });
    },
  });

  handler({ type: "event", event: "focus", payload: { chatId: "chat-1" } });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(queriedMachine, MACHINE, "chats were fetched for this machine");
  assert.equal(focused.length, 1, "focus executor called exactly once");
  assert.deepEqual(focused[0], {
    sessionId: "session-abc",
    cwd: "/repo/path",
    projectId: "proj-1",
    projectName: "My Project",
  });
  assert.ok(
    logs.some((l) => l.includes("focus event received for chat chat-1")),
    "receipt logged with the server chat id",
  );
}

// ── no chatId in payload → ignored, no focus ─────────────────────────────────
{
  let called = false;
  const handler = createFocusHandler({
    client: fakeClient({ chats: [], projectsById: {} }),
    machineId: MACHINE,
    logger,
    focus: async () => {
      called = true;
    },
  });
  handler({ type: "event", event: "focus", payload: {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false, "no chatId → focus never called");
}

// ── chat has no bound session yet → no focus (nothing to open) ───────────────
{
  let called = false;
  const client = fakeClient({
    chats: [
      { id: "chat-2", projectId: null, sessionId: null, cwd: null, handle: { kind: "cmux" } },
    ],
    projectsById: {},
  });
  const handler = createFocusHandler({
    client,
    machineId: MACHINE,
    logger,
    focus: async () => {
      called = true;
    },
  });
  handler({ type: "event", event: "focus", payload: { chatId: "chat-2" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false, "no bound session → focus skipped");
}

// ── unknown chat id → no focus ───────────────────────────────────────────────
{
  let called = false;
  const handler = createFocusHandler({
    client: fakeClient({
      chats: [{ id: "chat-1", projectId: null, sessionId: null, cwd: null, handle: {} }],
      projectsById: {},
    }),
    machineId: MACHINE,
    logger,
    focus: async () => {
      called = true;
    },
  });
  handler({ type: "event", event: "focus", payload: { chatId: "missing" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false, "chat not on this machine → focus skipped");
}

// ── a chat we only OBSERVED has no handle → not focusable from here ──────────
// §4's accepted asymmetry, asserted: we see every chat on the machine, and we
// can return you to the ones we launched. A discovered chat has a session id
// and no handle, and that must NOT be resume-spawned behind the user's back.
{
  let called = false;
  const handler = createFocusHandler({
    client: fakeClient({
      chats: [
        { id: "chat-3", projectId: null, sessionId: "found-session", cwd: "/elsewhere", handle: null },
      ],
      projectsById: {},
    }),
    machineId: MACHINE,
    logger,
    focus: async () => {
      called = true;
    },
  });
  handler({ type: "event", event: "focus", payload: { chatId: "chat-3" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false, "no handle → never focused, even with a known session");
  assert.ok(logs.some((l) => l.includes("has no handle")), "and it says why");
}

console.log("v2-focus smoke: OK");
