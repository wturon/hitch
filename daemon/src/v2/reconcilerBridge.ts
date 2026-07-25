// TRANSITIONAL — delete this file in Phase D, with the legacy chat routes.
//
// The V2 reconciler (daemon/src/v2/reconciler.ts) decides an assignment's
// observed_state from the LOCAL chat row: `deriveObserved({status, endedAt})`.
// Until the V3 rework, those two fields were maintained by the hook→event
// ledger→reducer pipeline, plus the observer's dead-process heal emitting a
// synthetic `session.ended`. All of that is gone: hooks now spool JSON the
// observer relays straight to the server, and status is derived there.
//
// So this is the one place that still carries observation back into
// `local_chats` — a thin adapter, in the WIRING layer, so the observer itself
// stays environment-blind and knows nothing about launches, assignments or
// this store. It NEVER creates a row: it only refreshes rows the reconciler
// already owns, and the moment the reconciler reads chats from the server this
// file goes away.
//
// Two deliberate limits, both inherited from the heal it replaces:
//   - `ended` is only ever concluded for CLAUDE. Codex existence is a
//     heuristic (no process info in its catalog — see codexObserver.ts), and a
//     false "ended" would close a live tab. The old `healDeadClaude` was
//     claude-only for exactly this reason.
//   - Nothing is concluded from a TRUNCATED snapshot. Absence proves nothing
//     when coverage was incomplete.

import type {
  ChatLifecycleHarness,
  ChatLifecycleStatus,
  ChatLifecycleStore,
} from "../chatLifecycleStore.js";
import type { ChatSnapshot, ObservedChat } from "../observer/types.js";

const storeHarness = (harness: string): ChatLifecycleHarness =>
  harness === "codex" ? "codex" : "claude-code";

// The observation axes → the store's legacy status vocabulary. This is a
// TRANSLATION, not a decision: the real status function lives on the server.
export function statusFromAxes(chat: ObservedChat): ChatLifecycleStatus {
  if (chat.existence !== "running") return "idle";
  if (chat.block != null) return "needs-input";
  if (chat.activity === "working") return "working";
  return "waiting";
}

export interface ReconcilerBridgeOptions {
  store: ChatLifecycleStore;
  host: string;
  now?: () => number;
}

export class ReconcilerBridge {
  private readonly store: ChatLifecycleStore;
  private readonly host: string;
  private readonly now: () => number;
  // Chats we saw as `running` on a previous tick, so we can tell "this process
  // ended" from "we never knew about it".
  private wasRunning = new Set<string>();

  constructor(options: ReconcilerBridgeOptions) {
    this.store = options.store;
    this.host = options.host;
    this.now = options.now ?? Date.now;
  }

  apply(snapshot: ChatSnapshot): void {
    const at = this.now();
    const present = new Set<string>();

    for (const chat of snapshot.chats) {
      const key = `${chat.harness}:${chat.sessionId}`;
      present.add(key);
      const localKey = `chat:${storeHarness(chat.harness)}:${this.host}:${chat.sessionId}`;
      const row = this.store.getLocalChat(localKey);
      if (!row) continue; // discovery-only chat — the server already has it

      const status = statusFromAxes(chat);
      // A claude chat with no live process has ended: that is precisely the
      // old dead-process heal, minus the event round trip.
      const ended =
        chat.harness === "claude" && chat.existence === "dormant" && this.wasRunning.has(key);
      const endedAt = ended ? (row.endedAt ?? at) : row.endedAt;
      if (row.status === status && row.endedAt === endedAt) continue;
      this.store.upsertLocalChat({
        ...row,
        status,
        endedAt,
        lastEventAt: at,
        lastStatusAt: at,
        updatedAt: at,
      });
    }

    if (!snapshot.window.truncated) {
      // Gone from the snapshot entirely — the daemon already spent its two-miss
      // debounce, and the server is about to call it dead.
      for (const key of this.wasRunning) {
        if (present.has(key)) continue;
        const [harness, sessionId] = splitKey(key);
        if (harness !== "claude") continue;
        const localKey = `chat:claude-code:${this.host}:${sessionId}`;
        const row = this.store.getLocalChat(localKey);
        if (!row || row.endedAt !== null) continue;
        this.store.upsertLocalChat({
          ...row,
          status: "idle",
          endedAt: at,
          lastEventAt: at,
          lastStatusAt: at,
          updatedAt: at,
        });
      }
    }

    const nextRunning = new Set<string>();
    for (const chat of snapshot.chats) {
      if (chat.existence === "running") nextRunning.add(`${chat.harness}:${chat.sessionId}`);
    }
    // A truncated snapshot can't retire anything, so keep what we knew.
    this.wasRunning = snapshot.window.truncated
      ? new Set([...this.wasRunning, ...nextRunning])
      : nextRunning;
  }
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(":");
  return [key.slice(0, index), key.slice(index + 1)];
}
