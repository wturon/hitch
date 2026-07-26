// The ATTACHMENT layer (docs/chat-tracking-redesign.md §4).
//
// Covers the three jobs — pre-registration, the codex nonce→thread bind, and
// the assignment→chat link — plus the property the join exists to guarantee:
// a chat is attached because it carried OUR launch nonce, never because it
// looked like a plausible match.

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
  launchId?: string;
  providerEvent?: string;
  lifecycle?: string;
}): SpooledEvent {
  return {
    eventId: `${input.chatId}-${Math.random()}`,
    source: "hook",
    producer: `${input.harness}-hook`,
    harness: input.harness,
    providerEvent: input.providerEvent ?? "UserPromptSubmit",
    lifecycle: input.lifecycle ?? "turn.started",
    status: "working",
    chatId: input.chatId,
    launchId: input.launchId ?? null,
    turnId: null,
    cwd: "/repo",
    host: HOST,
    observedAt: Date.now(),
    // Nothing environment-specific: the hook reports no surface, no pane, and
    // no terminal — only the nonce we put on the process.
    metadata: {},
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

  // ── codex: the nonce→thread join ──────────────────────────────────────────
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

    // A codex chat someone started by hand carries no nonce, so it is never
    // attached — the common case, and the one a cwd/timestamp heuristic would
    // get wrong by stealing this launch's assignment.
    a.onSpooledEvents([hookEvent({ harness: "codex", chatId: "thread-x" })]);
    assert.equal(a.lookup("codex", "thread-x"), null, "no nonce, no attachment");

    // A nonce we never issued resolves to nothing either.
    a.onSpooledEvents([
      hookEvent({ harness: "codex", chatId: "thread-y", launchId: "launch-someone-else" }),
    ]);
    assert.equal(a.lookup("codex", "thread-y"), null, "a foreign nonce never binds");

    // No chat row is created at spawn: nothing is injected for codex.
    assert.deepEqual(a.injected(clock), [], "codex is NOT pre-registered — the thread doesn't exist yet");

    // SessionStart is the real one, and it arrives before any prompt.
    a.onSpooledEvents([
      hookEvent({
        harness: "codex",
        chatId: "thread-1",
        launchId: "launch-codex",
        providerEvent: "SessionStart",
        lifecycle: "session.started",
      }),
    ]);
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

    // The nonce rides on EVERY event, so the later ones re-present a launch
    // that is already claimed. They must be inert — not a rebind, and not a
    // file write per turn.
    a.onSpooledEvents([
      hookEvent({ harness: "codex", chatId: "thread-1", launchId: "launch-codex" }),
    ]);
    assert.equal(
      a.lookup("codex", "thread-1")?.task,
      "assign-2",
      "a repeat event leaves the binding exactly as it was",
    );
  }

  // ── the join is a primary key, never a search ─────────────────────────────
  {
    const one = new LaunchStore({ path: join(dir, "one.json") });
    one.record({ launchId: "l-c" }, clock);
    assert.equal(one.claimByLaunchId("l-c", "t-1", clock)?.launchId, "l-c", "our nonce → matched");
    assert.equal(
      one.claimByLaunchId("l-c", "t-1", clock)?.launchId,
      "l-c",
      "re-presenting the same pairing is idempotent, not a second claim",
    );
    assert.equal(
      one.claimByLaunchId("l-c", "t-2", clock),
      null,
      "a claimed launch never rebinds to a DIFFERENT thread",
    );
    assert.equal(one.forSession("t-1", clock)?.launchId, "l-c", "…and stays findable by session");

    assert.equal(
      one.claimByLaunchId("l-unknown", "t-9", clock),
      null,
      "a nonce we never issued claims nothing",
    );

    const stale = new LaunchStore({ path: join(dir, "stale.json") });
    stale.record({ launchId: "l-d" }, clock - LAUNCH_TTL_MS - 1);
    assert.equal(
      stale.claimByLaunchId("l-d", "t-3", clock),
      null,
      "an expired launch never binds",
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
