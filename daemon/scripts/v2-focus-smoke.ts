import assert from "node:assert/strict";

import { createFocusHandler } from "../src/v2/focus.js";
import type { HitchClient } from "../src/v2/serverClient.js";

// The focus relay (M4 PR 6): a focus event carries the SERVER chat id; the
// handler resolves the chat's cmux_ref (session id + cwd) and drives the
// injected cmux focus. This smoke asserts that resolution — no server, no cmux.

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
        cmuxRef: { sessionId: "session-abc", cwd: "/repo/path", localKey: "chat:claude-code:h:session-abc" },
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
    chats: [{ id: "chat-2", projectId: null, cmuxRef: { localKey: "launch:x" } }],
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
    client: fakeClient({ chats: [{ id: "chat-1", projectId: null, cmuxRef: {} }], projectsById: {} }),
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

console.log("v2-focus smoke: OK");
