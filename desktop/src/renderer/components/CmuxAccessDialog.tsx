"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, RotateCw, Zap } from "lucide-react";

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

interface EnableCmuxResult {
  status: "created" | "updated" | "already-enabled";
  configPath: string;
  backupPath?: string;
}

// The preload bridge methods this dialog uses. We can't drive cmux's CLI/socket
// to fix this (that's the blocked channel); enableCmuxAutomation edits cmux's
// config file directly, and openCmuxApp uses LaunchServices — both socket-free.
interface HitchDaemonApi {
  enableCmuxAutomation: () => Promise<EnableCmuxResult>;
  openCmuxApp: () => Promise<string>;
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
  const [enabling, setEnabling] = useState(false);
  const [result, setResult] = useState<EnableCmuxResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    if (!bridge) return;
    setEnabling(true);
    setError(null);
    try {
      setResult(await bridge.enableCmuxAutomation());
    } catch (err) {
      setError(
        "Couldn't update cmux's config automatically — set it manually below.",
      );
      console.error("enableCmuxAutomation failed:", err);
    } finally {
      setEnabling(false);
    }
  }

  return (
    <>
      <DialogDescription>
        cmux is blocking apps that weren&apos;t launched from a cmux terminal
        from controlling it — that&apos;s its default{" "}
        <span className="font-medium text-foreground">cmux processes only</span>{" "}
        mode. Hitch can switch it to{" "}
        <span className="font-medium text-foreground">Automation</span> (any
        local process from the same user — the socket stays owner-only):
      </DialogDescription>

      {result ? (
        // Config written — the new mode only binds when cmux next starts, so the
        // one thing left is a restart. This is the key step; make it loud.
        <div className="rounded-md border border-foreground/10 bg-muted/50 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Check className="size-4" />
            {result.status === "already-enabled"
              ? "cmux is already set to Automation."
              : "Set cmux to Automation mode."}
          </p>
          <p className="mt-1 text-muted-foreground">
            Now <span className="font-medium text-foreground">quit cmux (⌘Q)
            and reopen it</span> for the change to take effect, then click{" "}
            <span className="font-medium text-foreground">Retry</span>.
          </p>
          {result.backupPath && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Backed up your previous config alongside{" "}
              <span className="font-mono">cmux.json</span>.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {bridge && (
            <Button onClick={enable} disabled={enabling} className="self-start">
              {enabling ? <LoaderCircle className="animate-spin" /> : <Zap />}
              Enable Automation in cmux
            </Button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              {bridge ? "Prefer to do it manually?" : "How to enable it"}
            </summary>
            <div className="mt-2 space-y-2">
              <p>
                In cmux, open{" "}
                <span className="font-medium text-foreground">
                  Settings → Automation
                </span>{" "}
                and set{" "}
                <span className="font-medium text-foreground">
                  Socket control
                </span>{" "}
                to{" "}
                <span className="font-medium text-foreground">Automation</span>{" "}
                — or set this in{" "}
                <span className="font-mono">~/.config/cmux/cmux.json</span>:
              </p>
              <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 p-2.5">
                <code className="truncate font-mono">
                  "automation": {"{"} "socketControlMode": "{RECOMMENDED_MODE}"{" "}
                  {"}"}
                </code>
                <CopyButton
                  value={`"socketControlMode": "${RECOMMENDED_MODE}"`}
                />
              </div>
              <p>Then quit and reopen cmux for it to take effect.</p>
            </div>
          </details>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        On a shared machine, prefer cmux&apos;s{" "}
        <span className="font-medium">Password</span> mode instead.
      </p>
    </>
  );
}

function UnavailableBody({ bridge }: { bridge: HitchDaemonApi | undefined }) {
  const [opening, setOpening] = useState(false);
  return (
    <>
      <DialogDescription>
        Hitch couldn&apos;t reach cmux — it doesn&apos;t look like cmux is
        running. Open cmux, then click Retry.
      </DialogDescription>
      {bridge && (
        <Button
          variant="outline"
          className="self-start"
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            try {
              await bridge.openCmuxApp();
            } catch (err) {
              console.error("openCmuxApp failed:", err);
            } finally {
              setOpening(false);
            }
          }}
        >
          {opening ? <LoaderCircle className="animate-spin" /> : <ExternalLink />}
          Open cmux
        </Button>
      )}
    </>
  );
}

// Shown when an "open/start chat in cmux" command comes back rejected. The two
// reasons map to distinct guidance; the dialog is controlled by the launcher.
// onRetry (when provided) re-issues the original launch — used after the user
// has switched cmux's mode and restarted it.
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
  const accessDenied = reason === "cmux-access-denied";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {accessDenied ? "Let Hitch control cmux" : "cmux isn’t running"}
          </DialogTitle>
        </DialogHeader>
        {accessDenied ? (
          <AccessDeniedBody bridge={bridge} />
        ) : (
          <UnavailableBody bridge={bridge} />
        )}
        <DialogFooter showCloseButton>
          <Button
            onClick={() => {
              onOpenChange(false);
              onRetry?.();
            }}
          >
            <RotateCw />
            Retry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
