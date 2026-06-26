// The read-only surface behind the desktop's cmux debug screen. It joins what
// Hitch has recorded about each cmux chat (the local lifecycle store) against
// what cmux actually reports right now (a live surface→checkpoint scan), and
// classifies the drift. None of this touches Convex — it's local debug data.

import { scanCmuxBindings } from "./cmux.js";
import type { ChatLifecycleStore, CmuxTraceRow, LocalChatRow } from "./chatLifecycleStore.js";

// ok           — exactly one cmux surface bound, or nothing to reconcile yet.
// multi-surface — >1 surface carries this session's checkpoint → resume focuses
//                 the wrong/ambiguous tab. Always a real bug.
// no-binding    — Hitch thinks this chat is live but cmux has no surface for it
//                 → resume will spawn a fresh workspace. Only flagged for active
//                 chats; an idle/closed chat with no surface is expected.
// closed        — inactive chat with no surface (normal; not drift).
export type CmuxDriftState = "ok" | "multi-surface" | "no-binding" | "closed";

export interface CmuxChatSummary {
  chatId: string | null;
  launchId: string | null;
  harness: string;
  title: string;
  status: string;
  cwd: string;
  host: string;
  pending: boolean;
  lastEventAt: number;
}

export interface CmuxReconcileEntry extends CmuxChatSummary {
  surfaces: string[];
  matchCount: number;
  drift: CmuxDriftState;
}

export interface CmuxReconcileResult {
  scannedAt: number;
  driftCount: number;
  entries: CmuxReconcileEntry[];
}

export interface CmuxTraceFilter {
  chatId?: string | null;
  launchId?: string | null;
}

export interface DebugApi {
  listCmuxChats(projectId: string | null): CmuxChatSummary[];
  reconcileCmux(projectId: string | null): Promise<CmuxReconcileResult>;
  readCmuxTrace(filter: CmuxTraceFilter, limit?: number): CmuxTraceRow[];
}

function summary(chat: LocalChatRow): CmuxChatSummary {
  return {
    chatId: chat.chatId,
    launchId: chat.launchId,
    harness: chat.harness,
    title: chat.title,
    status: chat.status,
    cwd: chat.cwd,
    host: chat.host,
    pending: chat.pending,
    lastEventAt: chat.lastEventAt,
  };
}

function classify(
  chat: LocalChatRow,
  matchCount: number,
): CmuxDriftState {
  if (!chat.chatId) return "ok"; // not bound yet — nothing to reconcile
  if (matchCount > 1) return "multi-surface";
  if (matchCount === 0) {
    const active = chat.status === "working" || chat.status === "needs-input";
    return active ? "no-binding" : "closed";
  }
  return "ok";
}

export function createDebugApi(store: ChatLifecycleStore): DebugApi {
  return {
    listCmuxChats(projectId) {
      return store.listCmuxChats(projectId).map(summary);
    },

    async reconcileCmux(projectId) {
      const chats = store.listCmuxChats(projectId);
      const bindings = await scanCmuxBindings();

      // checkpoint (session id) → the surfaces currently bound to it.
      const byCheckpoint = new Map<string, string[]>();
      for (const b of bindings) {
        if (!b.checkpoint) continue;
        const list = byCheckpoint.get(b.checkpoint) ?? [];
        list.push(b.surface);
        byCheckpoint.set(b.checkpoint, list);
      }

      const entries: CmuxReconcileEntry[] = chats.map((chat) => {
        const surfaces = chat.chatId
          ? (byCheckpoint.get(chat.chatId) ?? [])
          : [];
        return {
          ...summary(chat),
          surfaces,
          matchCount: surfaces.length,
          drift: classify(chat, surfaces.length),
        };
      });

      const driftCount = entries.filter(
        (e) => e.drift === "multi-surface" || e.drift === "no-binding",
      ).length;

      return { scannedAt: Date.now(), driftCount, entries };
    },

    readCmuxTrace(filter, limit) {
      return store.readCmuxTrace(filter, limit);
    },
  };
}
