import { useCallback, useEffect, useState } from "react";

import {
  BUILTIN_STARTING_PROMPTS,
  loadCustomPrompts,
  type StartingPrompt,
} from "@/lib/chat";
import {
  defaultModelFor,
  defaultReasoningFor,
  loadLastAgent,
  saveLastAgent,
  type ServerHarness,
} from "./delegation";

// The V2 delegate composer — ports the SHAPE of V1's useDelegationComposer
// (hooks/useDelegationComposer.ts, left byte-untouched):
//
//   • agent selection is a (harness, model) pair plus a reasoning/effort. V2
//     carries model/effort on the assignment again; the daemon passes them to
//     the launcher argv at spawn. No launch-param honoring gate is needed — V2
//     always spawns into cmux, which honors both.
//   • the prompt is the chosen INSTRUCTION text only (a preset body or the
//     user's one-off edit). The machine-facing task preamble is NOT in this
//     text — DelegateBar prepends it verbatim at delegate time via
//     composeDelegatePrompt, so the textarea stays about the instruction.
//
// Kept verbatim in spirit from V1: the last-agent seed (loadLastAgent /
// saveLastAgent on a successful delegate), the (harness, model) pair selection
// with effort resetting to the model default, the custom-prompts bridge
// (loadCustomPrompts — Decision 1: reuse, no prompt_templates table), the
// phase latch against double-launch, and the global ⌘⏎ arming.
export type ComposerPhase = "idle" | "sending" | "submitted";

export interface DelegateStartParams {
  harness: ServerHarness;
  // Kickoff-only launch params — passed to the launcher argv by the daemon.
  model: string;
  effort: string;
  // The chosen instruction text (preamble-free); DelegateBar composes the final
  // stamped prompt.
  prompt: string;
}

export interface DelegationComposerV2 {
  phase: ComposerPhase;
  // Agent selection (seeded from the user's last delegation, persisted on a
  // successful start).
  harness: ServerHarness;
  // Switch harness and reset model + effort to that harness's defaults.
  setHarness: (harness: ServerHarness) => void;
  model: string;
  effort: string;
  setEffort: (effort: string) => void;
  // Pick a (harness, model) pair from the combined dropdown's "h|m" value;
  // switching either resets effort to that model's default.
  chooseAgent: (value: string) => void;
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
  // Seed the pickers from the user's last V2 delegation, not a hardcoded
  // default — read once.
  const [harness, setHarnessRaw] = useState<ServerHarness>(
    () => loadLastAgent().harness,
  );
  const [model, setModelRaw] = useState(() => loadLastAgent().model);
  const [effort, setEffort] = useState(() => loadLastAgent().effort);
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

  // The combined agent primitive: pick a (harness, model) pair at once from a
  // "harness|model" value (ported from V1's chooseAgent). Switching either
  // resets reasoning to that model's default, since Codex exposes effort as
  // per-model capability metadata. Backs the standalone selects below.
  const chooseAgent = useCallback(
    (value: string) => {
      const sep = value.indexOf("|");
      const nextHarness = value.slice(0, sep) as ServerHarness;
      const nextModel = value.slice(sep + 1);
      setModelRaw(nextModel);
      if (nextHarness !== harness) setHarnessRaw(nextHarness);
      if (nextHarness !== harness || nextModel !== model) {
        setEffort(defaultReasoningFor(nextHarness, nextModel));
      }
    },
    [harness, model],
  );

  // Standalone harness Select: switch harness and reset model + effort to that
  // harness's defaults (routed through chooseAgent so the reset path is shared).
  const setHarness = useCallback(
    (next: ServerHarness) => {
      chooseAgent(`${next}|${defaultModelFor(next)}`);
    },
    [chooseAgent],
  );

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
      await onStart({ harness, model, effort, prompt });
      // Remember this exact combination for the next surface's composer.
      saveLastAgent({ harness, model, effort });
      setPhase("submitted");
    } catch (error) {
      // The launch never left — unlatch so the user can retry.
      setPhase("idle");
      throw error;
    }
  }, [phase, canStart, harness, model, effort, prompt, onStart]);

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
    model,
    effort,
    setEffort,
    chooseAgent,
    prompts,
    promptId,
    prompt,
    setPrompt,
    choosePreset,
    start,
  };
}
