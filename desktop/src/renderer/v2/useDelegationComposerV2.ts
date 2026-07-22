import { useCallback, useEffect, useState } from "react";

import {
  BUILTIN_STARTING_PROMPTS,
  loadCustomPrompts,
  type StartingPrompt,
} from "@/lib/chat";
import {
  loadLastHarness,
  saveLastHarness,
  type ServerHarness,
} from "./delegation";

// The V2 delegate composer — ports the SHAPE of V1's useDelegationComposer
// (hooks/useDelegationComposer.ts, left byte-untouched) minus everything V2's
// assignments model doesn't carry:
//
//   • agent selection is just a harness (claude | codex). No model/effort,
//     no environment/launch-param honoring — the daemon owns those at spawn.
//   • the prompt is the chosen INSTRUCTION text only (a preset body or the
//     user's one-off edit). The machine-facing task preamble is NOT in this
//     text — DelegateBar prepends it verbatim at delegate time via
//     composeDelegatePrompt, so the textarea stays about the instruction.
//
// Kept verbatim in spirit from V1: the last-agent seed (loadLastHarness /
// saveLastHarness on a successful delegate), the custom-prompts bridge
// (loadCustomPrompts — Decision 1: reuse, no prompt_templates table), the
// phase latch against double-launch, and the global ⌘⏎ arming.
export type ComposerPhase = "idle" | "sending" | "submitted";

export interface DelegateStartParams {
  harness: ServerHarness;
  // The chosen instruction text (preamble-free); DelegateBar composes the final
  // stamped prompt.
  prompt: string;
}

export interface DelegationComposerV2 {
  phase: ComposerPhase;
  harness: ServerHarness;
  setHarness: (harness: ServerHarness) => void;
  // Built-ins + the user's custom prompts (loaded once on mount).
  prompts: StartingPrompt[];
  promptId: string;
  // The editable instruction text. Manual edits are one-off — replaced on the
  // next preset pick, never written back to the preset.
  prompt: string;
  setPrompt: (prompt: string) => void;
  // Pick a preset by id (refills the instruction text).
  choosePreset: (id: string) => void;
  // Fire the delegation: guards re-entry via the phase latch, calls onStart,
  // remembers the harness on success, unlatches (and rethrows) on failure.
  start: () => Promise<void>;
}

export function useDelegationComposerV2({
  canStart,
  keyboardArmed,
  onStart,
}: {
  // False disables delegate entirely (no usable machine, no committed task).
  canStart: boolean;
  // The consumer's half of the ⌘⏎ gate — armed only in the compose/re-delegate
  // states while no delegation is in flight. The hook adds the phase latch.
  keyboardArmed: boolean;
  onStart: (params: DelegateStartParams) => Promise<void> | void;
}): DelegationComposerV2 {
  // Seed the picker from the user's last V2 delegation, not a hardcoded default.
  const [harness, setHarness] = useState<ServerHarness>(() => loadLastHarness());
  const [prompts, setPrompts] = useState<StartingPrompt[]>(
    BUILTIN_STARTING_PROMPTS,
  );
  const [promptId, setPromptId] = useState(BUILTIN_STARTING_PROMPTS[0].id);
  const [prompt, setPrompt] = useState(BUILTIN_STARTING_PROMPTS[0].body);
  const [phase, setPhase] = useState<ComposerPhase>("idle");

  // Load the user's custom prompts once (the bar remounts per task via the
  // dialog session key, so a mount-time load also refreshes after a settings
  // edit). Outside Hitch Desktop (no bridge) this resolves to [].
  useEffect(() => {
    let active = true;
    void loadCustomPrompts().then((custom) => {
      if (active) setPrompts([...BUILTIN_STARTING_PROMPTS, ...custom]);
    });
    return () => {
      active = false;
    };
  }, []);

  // Picking a preset refills the instruction text, which stays freely editable
  // for one-off tweaks — edits never write back to the saved preset.
  const choosePreset = useCallback(
    (id: string) => {
      const preset = prompts.find((p) => p.id === id);
      if (!preset) return;
      setPromptId(id);
      setPrompt(preset.body);
    },
    [prompts],
  );

  // Fire the delegation. The latch closes the window where a durable
  // assignment row can lag the mutation, so ⌘⏎ / click can't fire a second
  // launch; it clears only on remount (keyed per task) or a failed start.
  const start = useCallback(async () => {
    if (phase !== "idle" || !canStart) return;
    setPhase("sending");
    try {
      await onStart({ harness, prompt });
      saveLastHarness(harness);
      setPhase("submitted");
    } catch (error) {
      // The launch never left — unlatch so the user can retry.
      setPhase("idle");
      throw error;
    }
  }, [phase, canStart, harness, prompt, onStart]);

  // Global ⌘⏎ fires the current delegation from anywhere in the dialog, while
  // the consumer arms it and no delegation is latched in flight.
  useEffect(() => {
    if (!keyboardArmed || phase !== "idle") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || !e.metaKey || e.shiftKey || e.altKey || e.repeat) {
        return;
      }
      if (
        document.querySelector(
          '[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void start();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keyboardArmed, phase, start]);

  return {
    phase,
    harness,
    setHarness,
    prompts,
    promptId,
    prompt,
    setPrompt,
    choosePreset,
    start,
  };
}
