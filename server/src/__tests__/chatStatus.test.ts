import { describe, expect, it } from "vitest";

import {
  deriveChatStatus,
  type ChatActivity,
  type ChatBlock,
  type ChatExistence,
  type ChatStatus,
} from "../chatStatus.js";

// No database, no app — the status function is pure, and this is the whole
// matrix. If a rule here changes, the product's meaning of "busy" changed.

const EXISTENCES: (ChatExistence | null)[] = [null, "pending", "dormant", "running"];
const ACTIVITIES: (ChatActivity | null)[] = [null, "working", "idle", "unknown"];
const BLOCKS: (ChatBlock | null)[] = [null, "permission", "question"];

describe("deriveChatStatus", () => {
  it("covers the full existence × activity × block matrix", () => {
    // Expected value per (existence, activity, block), spelled out rather than
    // recomputed — a table that restates the implementation proves nothing.
    const expected: Record<string, ChatStatus> = {};
    const put = (e: string, a: string, b: string, s: ChatStatus) => {
      expected[`${e}/${a}/${b}`] = s;
    };
    for (const a of ACTIVITIES) {
      for (const b of BLOCKS) {
        // No existence observation at all → the chat is gone.
        put("null", String(a), String(b), "dead");
        // Launched by Hitch, not yet bound: spawning is busy.
        put("pending", String(a), String(b), "busy");
        // Transcript in the window, no process: idle and resumable. A block
        // never outlives its process, so it does not apply here.
        put("dormant", String(a), String(b), "idle");
        // Live process: block wins, then working, then idle.
        put("running", String(a), String(b), b !== null ? "waiting_input" : a === "working" ? "busy" : "idle");
      }
    }

    let checked = 0;
    for (const existence of EXISTENCES) {
      for (const activity of ACTIVITIES) {
        for (const block of BLOCKS) {
          const key = `${existence}/${activity}/${block}`;
          expect(deriveChatStatus({ existence, activity, block }), key).toBe(expected[key]);
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 4 * 3);
  });

  it("resolves unknown activity to idle, never busy", () => {
    // The stated design rule: idle beats guessing working. A wrong "busy" is
    // the failure that showed users an agent that had already died.
    expect(deriveChatStatus({ existence: "running", activity: "unknown", block: null })).toBe("idle");
    expect(deriveChatStatus({ existence: "running", activity: null, block: null })).toBe("idle");
  });

  it("keeps block independent of activity — a chat can be working AND blocked", () => {
    expect(deriveChatStatus({ existence: "running", activity: "working", block: "permission" })).toBe(
      "waiting_input",
    );
    expect(deriveChatStatus({ existence: "running", activity: "idle", block: "question" })).toBe(
      "waiting_input",
    );
  });

  it("ignores a block that outlived its process", () => {
    expect(deriveChatStatus({ existence: "dormant", activity: "idle", block: "permission" })).toBe("idle");
    expect(deriveChatStatus({ existence: null, activity: "working", block: "permission" })).toBe("dead");
  });

  it("reports dead only from missing existence — never from activity", () => {
    expect(deriveChatStatus({ existence: null, activity: null, block: null })).toBe("dead");
    expect(deriveChatStatus({ existence: "running", activity: "idle", block: null })).not.toBe("dead");
  });
});
