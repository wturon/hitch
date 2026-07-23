// V2 focus relay (M4 PR 6 — the daemon side of "Open chat").
//
// Focus is an EVENT, not state (PRD two-forms model): the desktop relays
// {event:"focus", payload:{chatId}} through the server to this machine's daemon;
// we bring the chat forward in cmux. Nothing is persisted — an undelivered focus
// just evaporates (the ~30s reconcile never re-derives it).
//
// Resolution: the payload carries the SERVER chat id. We look the chat up on the
// server (its cmux_ref, written at spawn by the reconciler / chatSync) to recover
// the cmux session id + cwd, then hand them to cmux.openChat, which
// focus-else-resume-spawns the surface AND raises the app (activateApp) — the
// same primitive V1 drives from its open-chat command path.
//
// The cmux executor is injectable so fake-launch mode (HITCH_FAKE_LAUNCH=1) can
// log instead of shelling to a cmux that isn't there — heal-proof headless e2e.

import { openChat, type OpenSpec } from "../cmux.js";
import type { HitchClient } from "./serverClient.js";

export interface FocusLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

// The WS event frame shape (mirror of @hitch/shared WsEventMessage — kept local
// so this module needs no shared import in its handler type).
export interface FocusEventMessage {
  type: "event";
  event: string;
  payload?: unknown;
}

// The cmux_ref jsonb the reconciler/chatSync stash on the server chat row. We
// read only the fields focus needs.
interface CmuxRefShape {
  sessionId?: unknown;
  cwd?: unknown;
}

interface WireChat {
  id: string;
  projectId: string | null;
  cmuxRef: unknown;
}

interface WireProject {
  id: string;
  name: string;
}

export interface FocusHandlerDeps {
  client: HitchClient;
  machineId: string;
  logger: FocusLogger;
  /**
   * The cmux focus executor. Defaults to the real cmux.openChat (focus-else-
   * resume-spawn + activateApp). Fake-launch mode injects a logging no-op so a
   * headless run never touches cmux.
   */
  focus?: (spec: OpenSpec) => Promise<unknown>;
}

/**
 * Build the WS `focus` event handler. Returns a fire-and-forget listener
 * (matching ServerWsClient.onEvent) that resolves the chat and drives cmux.
 */
export function createFocusHandler(
  deps: FocusHandlerDeps,
): (message: FocusEventMessage) => void {
  const { client, machineId, logger } = deps;
  const focus = deps.focus ?? ((spec: OpenSpec) => openChat(spec));

  async function fetchChat(chatId: string): Promise<WireChat | null> {
    const res = await client.daemon.chats.$get({ query: { machine_id: machineId } });
    if (!res.ok) {
      logger.error?.(`[hitch] focus: GET /daemon/chats failed (${res.status})`);
      return null;
    }
    const rows = (await res.json()) as WireChat[];
    return rows.find((c) => c.id === chatId) ?? null;
  }

  async function fetchProjectName(projectId: string): Promise<string> {
    try {
      const res = await client.projects[":id"].$get({ param: { id: projectId } });
      if (!res.ok) return "";
      return ((await res.json()) as WireProject).name ?? "";
    } catch {
      return "";
    }
  }

  async function handle(message: FocusEventMessage): Promise<void> {
    const payload = message.payload as { chatId?: unknown } | null | undefined;
    const chatId = typeof payload?.chatId === "string" ? payload.chatId : null;
    if (!chatId) {
      logger.info("[hitch] focus event ignored (no chatId in payload)");
      return;
    }
    logger.info(`[hitch] focus event received for chat ${chatId}`);

    const chat = await fetchChat(chatId);
    if (!chat) {
      logger.info(`[hitch] focus: chat ${chatId} not found on this machine`);
      return;
    }
    const ref = (chat.cmuxRef ?? {}) as CmuxRefShape;
    const sessionId = typeof ref.sessionId === "string" ? ref.sessionId : null;
    if (!sessionId) {
      logger.info(`[hitch] focus: chat ${chatId} has no bound session yet — nothing to focus`);
      return;
    }
    const projectName = chat.projectId ? await fetchProjectName(chat.projectId) : "";
    await focus({
      sessionId,
      cwd: typeof ref.cwd === "string" ? ref.cwd : undefined,
      projectId: chat.projectId ?? machineId,
      projectName,
    });
    logger.info(
      `[hitch] focus: brought chat ${chatId} (session ${sessionId.slice(0, 8)}) forward`,
    );
  }

  return (message) => {
    void handle(message).catch((error) => {
      logger.error?.(`[hitch] focus handler failed: ${String(error)}`);
    });
  };
}
