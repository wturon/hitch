// The ATTACHMENT layer (docs/chat-tracking-redesign.md §4).
//
// Covers the three jobs — pre-registration, the codex surface→thread bind, and
// the assignment→chat link — plus the property that used to live in the hook
// template and MUST NOT have changed when it moved: the surface-id match is
// deterministic, and anything other than exactly one candidate is never
// guessed at.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentLayer } from "../src/attachment/index.js";
import { LaunchStore, LAUNCH_TTL_MS } from "../src/attachment/launches.js";
import type { SpooledEvent } from "../src/observer/spool.js";
import type { HitchClient } from "../src/v2/serverClient.js";

const HOST = "smoke-host";
const logger = { info: () => {}, error: (m: string) => console.error(m) };

const patched: Array<{ id: string; chatId: string }> = [];
let patchOk = true;
const client = {
  daemon: {
    assignments: {
      ":id": {
        $patch: async (input: { param: { id: string }; json: { chatId: string } }) => {
          if (patchOk) patched.push({ id: input.param.id, chatId: input.json.chatId });
          return { ok: patchOk, status: patchOk ? 200 : 500 };
        },
      },
    },
  },
} as unknown as HitchClient;

function hookEvent(input: {
  harness: string;
  chatId: string;
  surfaceId?: string;
  lifecycle?: string;
}): SpooledEvent {
  return {
    eventId: `${input.chatId}-${Math.random()}`,
    source: "hook",
    producer: `${input.harness}-hook`,
    harness: input.harness,
    providerEvent: "UserPromptSubmit",
    lifecycle: input.lifecycle ?? "turn.started",
    status: "working",
    chatId: input.chatId,
    launchId: null,
    turnId: null,
    cwd: "/repo",
    host: HOST,
    observedAt: Date.now(),
    metadata: input.surfaceId ? { environment: "cmux", surfaceId: input.surfaceId } : {},
  };
}

const dir = mkdtempSync(join(tmpdir(), "hitch-attachment-smoke-"));
const env = { HITCH_APP_SUPPORT_DIR: dir } as NodeJS.ProcessEnv;
let clock = 1_000_000;
const now = () => clock;
const make = () => new AttachmentLayer({ client, host: HOST, logger, env, now });

try {
  // ── claude: pre-registration → injection → link ───────────────────────────
  {
    const a = make();
    a.registerLaunch({
      launchId: "launch-claude",
      assignmentId: "assign-1",
      harness: "claude",
      cwd: "/repo",
      projectId: "proj-1",
      title: "Ship it",
    });
    assert.equal(a.launchPending("assign-1"), true, "a recorded launch is in flight");
    assert.deepEqual(a.injected(clock), [], "nothing to inject before a session id exists");

    a.bindSession("launch-claude", "sess-1");
    const injected = a.injected(clock);
    assert.equal(injected.length, 1, "a bound claude session is pre-registered");
    assert.equal(injected[0].existence, "pending", "pre-registration is `pending` existence");
    assert.equal(injected[0].source, "launch-pending");
    assert.equal(injected[0].task, "assign-1", "attachment 1: the assignment it serves");
    assert.equal(injected[0].projectId, "proj-1");
    assert.equal(injected[0].title, "Ship it");
    assert.equal(
      (injected[0].handle as Record<string, unknown>).sessionId,
      "sess-1",
      "attachment 2: a handle we can focus/close through",
    );

    // Discovery takes over → we stop claiming existence, but keep decorating.
    a.observed("claude", "sess-1");
    assert.deepEqual(a.injected(clock), [], "observation owns existence once it sees the session");
    assert.equal(a.lookup("claude", "sess-1")?.task, "assign-1", "attachment survives discovery");

    // The link: the snapshot PUT echoes the row it upserted.
    await a.resolveLinks([{ id: "chat-1", harness: "claude", sessionId: "sess-1" }]);
    assert.deepEqual(patched, [{ id: "assign-1", chatId: "chat-1" }], "assignment linked once");
    await a.resolveLinks([{ id: "chat-1", harness: "claude", sessionId: "sess-1" }]);
    assert.equal(patched.length, 1, "…and never re-linked");
    assert.equal(a.launchPending("assign-1"), false, "a linked launch is no longer in flight");
  }

  // ── a failed link is retried, not dropped ─────────────────────────────────
  {
    patched.length = 0;
    const a = make();
    a.registerLaunch({
      launchId: "launch-retry",
      assignmentId: "assign-retry",
      harness: "claude",
      cwd: "/repo",
      projectId: null,
      title: "Retry",
    });
    a.bindSession("launch-retry", "sess-retry");
    patchOk = false;
    await a.resolveLinks([{ id: "chat-r", harness: "claude", sessionId: "sess-retry" }]);
    assert.equal(patched.length, 0, "the PATCH failed");
    patchOk = true;
    await a.resolveLinks([{ id: "chat-r", harness: "claude", sessionId: "sess-retry" }]);
    assert.deepEqual(patched, [{ id: "assign-retry", chatId: "chat-r" }], "…and was retried");
  }

  // ── codex: the surface-id join, moved out of the hook VERBATIM ────────────
  {
    patched.length = 0;
    const a = make();
    a.registerLaunch({
      launchId: "launch-codex",
      assignmentId: "assign-2",
      harness: "codex",
      cwd: "/repo",
      projectId: "proj-1",
      title: "Codex task",
    });
    // The launcher stamps the pane id before the command runs.
    a.launches.stampSurface("launch-codex", "SURFACE-7", clock);

    // An event from another pane resolves to nothing.
    a.onSpooledEvents([hookEvent({ harness: "codex", chatId: "thread-x", surfaceId: "surface-9" })]);
    assert.equal(a.lookup("codex", "thread-x"), null, "a foreign surface never binds");

    // No chat row is created at spawn: nothing is injected for codex.
    assert.deepEqual(a.injected(clock), [], "codex is NOT pre-registered — the thread doesn't exist yet");

    // The real one — case-insensitive, exactly as the hook matched.
    a.onSpooledEvents([hookEvent({ harness: "codex", chatId: "thread-1", surfaceId: "surface-7" })]);
    const bound = a.lookup("codex", "thread-1");
    assert.equal(bound?.task, "assign-2", "the thread bound to the launch's assignment");
    assert.equal(
      (bound?.handle as Record<string, unknown>).sessionId,
      "thread-1",
      "and got a handle keyed by the thread id",
    );
    assert.deepEqual(
      a.injected(clock),
      [],
      "binding decorates; it never invents an existence observation never made",
    );

    await a.resolveLinks([{ id: "chat-2", harness: "codex", sessionId: "thread-1" }]);
    assert.deepEqual(patched, [{ id: "assign-2", chatId: "chat-2" }]);
  }

  // ── ambiguity is NEVER guessed at ─────────────────────────────────────────
  {
    const store = new LaunchStore({ path: join(dir, "ambiguous.json") });
    store.record({ launchId: "l-a", surfaceId: "surface-dup" }, clock);
    store.record({ launchId: "l-b", surfaceId: "surface-dup" }, clock);
    assert.equal(
      store.claimBySurface("surface-dup", "thread-dup", clock),
      null,
      "two candidates on one surface → no match, no guess",
    );
    // Neither was consumed, so a later disambiguation is still possible.
    assert.deepEqual(
      store.list(clock).map((r) => r.claimedAt),
      [undefined, undefined],
      "an ambiguous match consumes nothing",
    );

    const one = new LaunchStore({ path: join(dir, "one.json") });
    one.record({ launchId: "l-c", surfaceId: "surface-1" }, clock);
    assert.equal(one.claimBySurface("surface-1", "t-1", clock)?.launchId, "l-c", "one → matched");
    assert.equal(
      one.claimBySurface("surface-1", "t-2", clock),
      null,
      "a consumed claim is never matched again",
    );
    assert.equal(one.forSession("t-1", clock)?.launchId, "l-c", "…but stays findable by session");

    const stale = new LaunchStore({ path: join(dir, "stale.json") });
    stale.record({ launchId: "l-d", surfaceId: "surface-2" }, clock - LAUNCH_TTL_MS - 1);
    assert.equal(
      stale.claimBySurface("surface-2", "t-3", clock),
      null,
      "an expired claim never binds",
    );
    assert.deepEqual(stale.list(clock), [], "…and is pruned on the way past");
  }

  // ── durability: a restart mid-launch neither re-spawns nor loses the link ─
  {
    patched.length = 0;
    const first = make();
    first.registerLaunch({
      launchId: "launch-restart",
      assignmentId: "assign-3",
      harness: "claude",
      cwd: "/repo",
      projectId: null,
      title: "Survives a restart",
    });
    first.bindSession("launch-restart", "sess-3");

    const restarted = make(); // a fresh process, same app-support dir
    assert.equal(
      restarted.launchPending("assign-3"),
      true,
      "the launch record is durable — the reconciler will NOT re-spawn",
    );
    const injected = restarted.injected(clock);
    assert.equal(injected.length, 1, "and the pre-registration is rebuilt from disk");
    assert.equal(injected[0].sessionId, "sess-3");
    await restarted.resolveLinks([{ id: "chat-3", harness: "claude", sessionId: "sess-3" }]);
    assert.deepEqual(patched, [{ id: "assign-3", chatId: "chat-3" }], "the link still lands");
  }

  // ── expiry: a launch that never binds is reported, not left hanging ───────
  {
    const a = make();
    a.registerLaunch({
      launchId: "launch-lost",
      assignmentId: "assign-lost",
      harness: "codex",
      cwd: "/repo",
      projectId: null,
      title: "Never binds",
    });
    assert.deepEqual(a.sweep(), [], "nothing expires while it's fresh");
    assert.equal(a.launchPending("assign-lost"), true);

    clock += LAUNCH_TTL_MS + 1;
    assert.deepEqual(a.sweep(), ["assign-lost"], "past the TTL it is reported as never bound");
    assert.equal(
      a.launchPending("assign-lost"),
      false,
      "…which is what turns the reconciler's `spawning` into `dead`",
    );
  }

  console.log("attachment smoke: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
