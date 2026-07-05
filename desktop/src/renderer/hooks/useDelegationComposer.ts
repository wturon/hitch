"use client";

import { useCallback, useEffect, useState } from "react";

import {
  BUILTIN_STARTING_PROMPTS,
  buildStartPrompt,
  defaultEnvironment,
  defaultReasoning,
  honorsLaunchParams,
  isEnvironment,
  loadCustomPrompts,
  loadLastAgent,
  saveLastAgent,
  type Environment,
  type Harness,
  type StartingPrompt,
} from "@/lib/chat";

// Sentinel value for the preset dropdown's footer action. It's not a real
// preset id — selecting it jumps to the Settings prompt manager instead of
// picking a prompt. Exported so every chrome renders the same sentinel item.
export const MANAGE_PROMPTS_VALUE = "__manage_prompts__";

export interface DelegationStartParams {
  harness: Harness;
  model: string;
  effort: string;
  prompt: string;
}

// The compose lifecycle, as a state enum (not booleans) so slice 5/6 can layer
// the linked/requested/completed footer states around it without reshaping:
//   idle      — composing; Send/⌘⏎ live.
//   sending   — the start mutation is in flight (disables Send).
//   submitted — a delegation was fired and latched. Deliberately NOT reset on
//               success: the durable `chat-request` flag can lag the mutation
//               (files round-trip) — or never adopt while a dirty editor stays
//               open — leaving a window where Send/⌘⏎ would fire a SECOND
//               launch. The latch closes that window; it clears only when the
//               consumer remounts (keyed per task) or the start fails (retry).
export type DelegationComposerPhase = "idle" | "sending" | "submitted";

export interface DelegationComposer {
  phase: DelegationComposerPhase;
  // Agent selection (seeded from the user's last delegation, persisted on a
  // successful start).
  harness: Harness;
  model: string;
  effort: string;
  setEffort: (effort: string) => void;
  // Built-ins + the user's custom prompts (loaded once on mount).
  prompts: StartingPrompt[];
  promptId: string;
  // The editable prompt text. Manual edits are one-off — replaced on the next
  // preset pick or title/path change, never written back to the preset.
  prompt: string;
  setPrompt: (prompt: string) => void;
  // Pick a (harness, model) pair from the combined dropdown's "h|m" value;
  // switching either resets effort to that model's default.
  chooseAgent: (value: string) => void;
  // Pick a preset by id (refills the prompt), or the MANAGE_PROMPTS_VALUE
  // sentinel (jumps to settings instead).
  choosePreset: (id: string) => void;
  // Fire the delegation: guards re-entry, calls onStart, remembers the agent
  // combination on success, unlatches (and rethrows) on failure.
  start: () => Promise<void>;
  // Whether the chosen (harness, environment) accepts model/effort at launch —
  // e.g. Claude in an editor extension does not, so those controls disable.
  paramsHonored: boolean;
  currentEnv: Environment;
}

// The canonical delegation compose model, extracted from DelegationBand so
// every delegate surface (the board dialog's floating band, the todo dialog's
// docked footer, and slice 5's existing-todo states) shares ONE state machine
// and only the chrome differs: loadLastAgent seeding + saveLastAgent on
// success, prompt preset loading/selection, harness/model/effort selection,
// launch-param honoring, the start call, and the global ⌘⏎ arming.
//
// `canStart` gates start() itself (the band passes canDelegate — a draft with
// no title has nothing to launch against). `keyboardArmed` is the consumer's
// half of the ⌘⏎ gate (the band arms only while no chat is linked or in
// flight; the todo footer arms once the transform settles); the hook adds its
// own half — the phase latch — so a fired delegation can't double-launch.
export function useDelegationComposer({
  title,
  path,
  canStart,
  keyboardArmed,
  onStart,
  onManagePrompts,
}: {
  title: string;
  path: string;
  canStart: boolean;
  keyboardArmed: boolean;
  onStart: (params: DelegationStartParams) => Promise<void> | void;
  onManagePrompts?: () => void;
}): DelegationComposer {
  // Seed the pickers from the user's last delegation, not a hardcoded default,
  // so "the defaults are already selected" means their defaults. Read once.
  const [harness, setHarness] = useState<Harness>(() => loadLastAgent().harness);
  const [model, setModel] = useState(() => loadLastAgent().model);
  const [effort, setEffort] = useState(() => loadLastAgent().effort);
  // Per-harness run environment, read from the local daemon bridge.
  const [harnessEnvs, setHarnessEnvs] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<StartingPrompt[]>(
    BUILTIN_STARTING_PROMPTS,
  );
  const [promptId, setPromptId] = useState(BUILTIN_STARTING_PROMPTS[0].id);
  const [prompt, setPrompt] = useState(() =>
    buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], { title, path }),
  );
  const [phase, setPhase] = useState<DelegationComposerPhase>("idle");

  // Load the user's custom prompts once. Consumers remount per task (keyed by
  // the task path), so a mount-time load also refreshes after a settings edit
  // reopens the dialog. Kept out of the title/path effect below so typing a
  // draft's title doesn't re-hit the bridge on every keystroke.
  useEffect(() => {
    let active = true;
    void loadCustomPrompts().then((custom) => {
      if (active) setPrompts([...BUILTIN_STARTING_PROMPTS, ...custom]);
    });
    return () => {
      active = false;
    };
  }, []);

  // Refill the preview prompt from the first built-in whenever the target task
  // changes — the preamble embeds the title + file path, and a fresh draft's
  // prospective path resolves as its title is typed. Manual edits are one-off
  // and replaced here (prior behavior).
  useEffect(() => {
    setPromptId(BUILTIN_STARTING_PROMPTS[0].id);
    setPrompt(buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], { title, path }));
  }, [title, path]);

  // Read the per-harness environment preference once, so we know whether the
  // selected harness honors launch params (Claude in vscode/cursor does not).
  useEffect(() => {
    const bridge =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              hitchDaemon?: {
                getHarnessEnvironments?: () => Promise<Record<string, string>>;
              };
            }
          ).hitchDaemon
        : undefined;
    if (!bridge?.getHarnessEnvironments) return;
    void bridge
      .getHarnessEnvironments()
      .then((map) => setHarnessEnvs(map ?? {}))
      .catch(() => {});
  }, []);

  // The combined agent dropdown picks a (harness, model) pair at once.
  // Switching either resets reasoning to that model's default, since Codex
  // exposes effort as model capability metadata.
  function chooseAgent(value: string) {
    const sep = value.indexOf("|");
    const nextHarness = value.slice(0, sep) as Harness;
    const nextModel = value.slice(sep + 1);
    setModel(nextModel);
    if (nextHarness !== harness) {
      setHarness(nextHarness);
    }
    if (nextHarness !== harness || nextModel !== model) {
      setEffort(defaultReasoning(nextHarness, nextModel));
    }
  }

  // Picking a preset refills the prompt, which stays freely editable for
  // one-off tweaks — edits never write back to the saved preset.
  function choosePreset(id: string) {
    if (id === MANAGE_PROMPTS_VALUE) {
      onManagePrompts?.();
      return;
    }
    const preset = prompts.find((p) => p.id === id);
    if (!preset) return;
    setPromptId(id);
    setPrompt(buildStartPrompt(preset, { title, path }));
  }

  // Fire the delegation. We don't track a launch state beyond the latch: the
  // moment onStart's mutation resolves, the doc carries `chat-request:
  // requested`, and the consumer reflects it off the files subscription —
  // durable and dialog-independent.
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
  }, [phase, canStart, effort, harness, model, onStart, prompt]);

  // Global ⌘⏎ fires the current delegation from anywhere in the dialog, while
  // the consumer arms it and no delegation is latched in flight.
  useEffect(() => {
    if (!keyboardArmed || phase !== "idle") return;
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.key !== "Enter" ||
        !e.metaKey ||
        e.shiftKey ||
        e.altKey ||
        e.repeat
      ) {
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

  // Whether the current (harness, environment) pair accepts model/effort at
  // launch. Unset env falls back to the harness default.
  const storedEnv = harnessEnvs[harness];
  const currentEnv: Environment = isEnvironment(storedEnv ?? "")
    ? (storedEnv as Environment)
    : defaultEnvironment(harness);
  const paramsHonored = honorsLaunchParams(harness, currentEnv);

  return {
    phase,
    harness,
    model,
    effort,
    setEffort,
    prompts,
    promptId,
    prompt,
    setPrompt,
    chooseAgent,
    choosePreset,
    start,
    paramsHonored,
    currentEnv,
  };
}
