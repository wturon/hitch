// The Inbox is identified BY NAME, not by a flag or an id: it's ensured on boot
// (created if missing), pinned first in the rail, and is the default selection.
// A project whose name matches is RENDERED as the inbox — which deliberately has
// no settings menu, since renaming or repointing it would orphan it.
//
// That makes the name reserved, and the reservation has to hold at every door
// that sets one. A second project called "Inbox" isn't a cosmetic duplicate: it
// renders as an inbox, so it loses the context menu that is the only way to
// reach its own settings — permanently, since V2 has no rename-or-delete UI
// outside that dialog.
export const INBOX_NAME = "Inbox";

export function isReservedProjectName(name: string): boolean {
  return name.trim().toLowerCase() === INBOX_NAME.toLowerCase();
}

export const RESERVED_NAME_MESSAGE = `“${INBOX_NAME}” is reserved. Pick another name.`;
