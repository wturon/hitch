"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, RotateCw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// The failure kinds the daemon tags onto a launch command (see daemon cmux.ts).
// Only these two get a guided dialog; anything else falls back to a log line.
export type CmuxAccessReason = "cmux-access-denied" | "cmux-unavailable";

// The cmux setting that fixes the common case. "automation" drops cmux's
// ancestry check but keeps the socket owner-only (same macOS user), so it's the
// least-permissive mode that lets a Dock-launched Hitch drive cmux.
const RECOMMENDED_MODE = "automation";

// The bits of the preload bridge this dialog drives. `cmux settings open` and
// `cmux reload-config` are dispatched via cmux's URL handler, not its automation
// socket, so they work even while the socket is in the mode that's blocking us.
interface HitchDaemonApi {
  openCmuxSettings: () => Promise<string>;
  reloadCmuxConfig: () => Promise<string>;
}

function useDaemonBridge(): HitchDaemonApi | undefined {
  return typeof window !== "undefined"
    ? (window.hitchDaemon as unknown as HitchDaemonApi | undefined)
    : undefined;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked — the value is visible for manual copy anyway.
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function AccessDeniedBody({ bridge }: { bridge: HitchDaemonApi | undefined }) {
  // Tracks the inline "Open cmux settings" action so we can show a spinner and
  // surface the rare failure (e.g. cmux binary not found) without a dead button.
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  async function openSettings() {
    if (!bridge) return;
    setOpening(true);
    setOpenError(null);
    try {
      await bridge.openCmuxSettings();
    } catch (err) {
      setOpenError(
        "Couldn't open cmux automatically — open it and go to Settings → Automation.",
      );
      console.error("openCmuxSettings failed:", err);
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <DialogDescription>
        cmux is blocking apps that weren&apos;t launched from a cmux terminal
        from controlling it — that&apos;s its default{" "}
        <span className="font-medium text-foreground">cmux processes only</span>{" "}
        mode. To let Hitch open and resume chats in cmux, allow same-user
        automation:
      </DialogDescription>
      <ol className="ml-4 list-decimal space-y-1.5 text-sm text-muted-foreground">
        <li>
          Open{" "}
          {bridge ? (
            <button
              type="button"
              onClick={openSettings}
              disabled={opening}
              className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
            >
              {opening ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <ExternalLink className="size-3" />
              )}
              cmux&apos;s Automation settings
            </button>
          ) : (
            <span className="font-medium text-foreground">
              cmux → Settings → Automation
            </span>
          )}
          .
        </li>
        <li>
          Set <span className="font-medium text-foreground">Socket control</span>{" "}
          to <span className="font-medium text-foreground">Automation</span> (any
          local process from the same user — the socket stays owner-only).
        </li>
        <li>
          Reload cmux with the button below (or press{" "}
          <kbd className="rounded bg-muted px-1 font-mono">⌘⇧,</kbd> in cmux),
          then reopen the chat.
        </li>
      </ol>
      {openError && <p className="text-sm text-destructive">{openError}</p>}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          Prefer editing config directly?
        </summary>
        <div className="mt-2 rounded-md bg-muted/50 p-2.5">
          <p className="mb-1.5">
            Set this in{" "}
            <span className="font-mono">~/.config/cmux/cmux.json</span>:
          </p>
          <div className="flex items-center justify-between gap-2">
            <code className="truncate font-mono">
              "automation": {"{"} "socketControlMode": "{RECOMMENDED_MODE}" {"}"}
            </code>
            <CopyButton value={`"socketControlMode": "${RECOMMENDED_MODE}"`} />
          </div>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">
        On a shared machine, prefer cmux&apos;s{" "}
        <span className="font-medium">Password</span> mode instead.
      </p>
    </>
  );
}

function UnavailableBody() {
  return (
    <DialogDescription>
      Hitch couldn&apos;t reach cmux — it doesn&apos;t look like cmux is running.
      Open the cmux app, then reopen the chat.
    </DialogDescription>
  );
}

// Shown when an "open/start chat in cmux" command comes back rejected. The two
// reasons map to distinct guidance; the dialog is controlled by the launcher.
// onRetry (when provided) re-issues the original launch after a config reload.
export function CmuxAccessDialog({
  open,
  onOpenChange,
  reason,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: CmuxAccessReason;
  onRetry?: () => void;
}) {
  const bridge = useDaemonBridge();
  const [reloading, setReloading] = useState(false);

  const accessDenied = reason === "cmux-access-denied";

  async function reloadAndRetry() {
    if (bridge && accessDenied) {
      setReloading(true);
      try {
        await bridge.reloadCmuxConfig();
      } catch (err) {
        // If reload fails the user can still ⌘⇧, themselves; retry anyway.
        console.error("reloadCmuxConfig failed:", err);
      } finally {
        setReloading(false);
      }
    }
    onOpenChange(false);
    onRetry?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {accessDenied ? "Let Hitch control cmux" : "cmux isn’t running"}
          </DialogTitle>
        </DialogHeader>
        {accessDenied ? <AccessDeniedBody bridge={bridge} /> : <UnavailableBody />}
        <DialogFooter showCloseButton>
          <Button onClick={reloadAndRetry} disabled={reloading}>
            {reloading ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            {accessDenied && bridge ? "Reload cmux & retry" : "Retry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
