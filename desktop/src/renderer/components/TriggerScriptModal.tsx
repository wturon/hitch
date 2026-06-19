"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CodeXmlIcon, EllipsisIcon, Trash2Icon } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

const STARTER_SCRIPT = `#!/usr/bin/env bash
# exit 0 → run · non-zero (2) → skip this cycle
set -euo pipefail

# Cheap gate before the agent run. Print context on stdout; it is injected
# into the prompt. Example:
# open=$(gh pr list --state open --json number --jq 'length')
# [ "$open" -gt 0 ]
`;

// The result of a "Run test" — the main process runs the draft script.
export interface TriggerTestResult {
  exitCode: number | null; // null = killed (timeout / signal)
  durationMs: number;
  stdout: string;
  stderr: string;
}

// The trigger.sh editor: a line-gutter code editor, a test-output panel, and a
// footer to run the test and Save & trust. Trust is per script path + SHA-256:
// saving recomputes the hash and stores it locally; editing the bytes
// invalidates it until re-trusted. See the Loops PRD "Script trust".
export function TriggerScriptModal({
  open,
  onOpenChange,
  projectId,
  projectCwd,
  scriptPath,
  content,
  trustedHash,
  onSave,
  onTrust,
  onClearTrust,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"projects">;
  projectCwd?: string;
  slug: string;
  scriptPath: string;
  content: string | null; // null = no trigger.sh yet
  trustedHash: string | undefined;
  onSave: (path: string, content: string) => Promise<void>;
  onTrust: (scriptPath: string, hash: string) => void;
  onClearTrust: (scriptPath: string) => void;
  onRemove?: (scriptPath: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(content ?? STARTER_SCRIPT);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [test, setTest] = useState<TriggerTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Reset the draft to the live file whenever the modal opens.
  useEffect(() => {
    if (open) {
      setDraft(content ?? STARTER_SCRIPT);
      setTest(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Track the SHA-256 of the current draft bytes so we can show trust state.
  useEffect(() => {
    let alive = true;
    void sha256(draft).then((h) => {
      if (alive) setCurrentHash(h);
    });
    return () => {
      alive = false;
    };
  }, [draft]);

  const trustState: "trusted" | "changed" | "untrusted" = useMemo(() => {
    if (trustedHash === undefined) return "untrusted";
    if (currentHash && currentHash === trustedHash) return "trusted";
    return "changed";
  }, [trustedHash, currentHash]);

  const lines = useMemo(() => draft.split("\n").length, [draft]);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const bridge =
        typeof window !== "undefined"
          ? (window.hitchDaemon as unknown as {
              runLoopTrigger?: (args: {
                projectId: string;
                cwd?: string;
                script: string;
              }) => Promise<TriggerTestResult>;
            } | undefined)
          : undefined;
      if (!bridge?.runLoopTrigger) {
        setTest({
          exitCode: null,
          durationMs: 0,
          stdout: "",
          stderr: "Run test is unavailable (no desktop bridge).",
        });
        return;
      }
      const result = await bridge.runLoopTrigger({
        projectId,
        cwd: projectCwd,
        script: draft,
      });
      setTest(result);
    } finally {
      setTesting(false);
    }
  }

  async function saveAndTrust() {
    setSaving(true);
    try {
      await onSave(scriptPath, draft);
      const hash = currentHash ?? (await sha256(draft));
      onTrust(scriptPath, hash);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!onRemove) return;
    await onRemove(scriptPath);
    onClearTrust(scriptPath);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[760px] max-w-[760px] gap-0 overflow-hidden p-0 sm:max-w-[760px]"
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2">
            <CodeXmlIcon className="size-4 text-muted-foreground" />
            <span className="font-mono text-sm font-semibold text-foreground">
              trigger.sh
            </span>
            <TrustBadge state={trustState} />
          </div>
          {content !== null && onRemove && (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Trigger actions"
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                  />
                }
              >
                <EllipsisIcon className="size-4" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  onClick={() => void remove()}
                  className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
                >
                  <Trash2Icon />
                  Remove trigger
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>

        {/* editor with line gutter */}
        <div className="flex max-h-[340px] overflow-auto border-y border-border bg-muted/30">
          <div
            aria-hidden
            className="select-none px-3 py-3 text-right font-mono text-[12px] leading-[18px] text-muted-foreground/50"
          >
            {Array.from({ length: lines }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-[200px] flex-1 resize-none bg-transparent py-3 pr-4 font-mono text-[13px] leading-[18px] text-foreground outline-none"
          />
        </div>

        {/* test output */}
        <div className="flex flex-col gap-2 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Test output
            </span>
            {test && (
              <span className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    test.exitCode === 0
                      ? "bg-muted text-foreground"
                      : "bg-[#B42318]/10 text-[#B42318]",
                  )}
                >
                  {test.exitCode === null ? "killed" : `exit ${test.exitCode}`}
                </span>
                <span>· {(test.durationMs / 1000).toFixed(1)}s</span>
                <span>
                  ·{" "}
                  {test.exitCode === 0
                    ? "would run"
                    : test.exitCode === 2
                      ? "would skip"
                      : "would skip (trigger error)"}
                </span>
              </span>
            )}
          </div>
          <pre className="max-h-28 min-h-[40px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2 font-mono text-[12px] text-foreground">
            {test
              ? [test.stdout, test.stderr].filter(Boolean).join("\n") ||
                "(no output)"
              : "Run test to preview exit code and stdout."}
          </pre>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {testing ? "Running…" : "Run test"}
          </button>
          <button
            type="button"
            onClick={() => void saveAndTrust()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            Save &amp; trust
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TrustBadge({
  state,
}: {
  state: "trusted" | "changed" | "untrusted";
}) {
  if (state === "trusted") {
    return (
      <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
        <span className="text-[#16A34A]">✓</span> Trusted
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[#B42318]/10 px-2 py-0.5 text-[11px] text-[#B42318]">
      {state === "changed" ? "Changed since trusted" : "Review required"}
    </span>
  );
}
