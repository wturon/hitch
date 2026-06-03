"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

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

function AccessDeniedBody() {
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
          In cmux, open{" "}
          <span className="font-medium text-foreground">
            Settings → Automation
          </span>
          .
        </li>
        <li>
          Set <span className="font-medium text-foreground">Socket control</span>{" "}
          to{" "}
          <span className="font-medium text-foreground">Automation</span> (any
          local process from the same user — the socket stays owner-only).
        </li>
        <li>
          Press <kbd className="rounded bg-muted px-1 font-mono">⌘⇧,</kbd> in
          cmux to reload its config, then try opening the chat again.
        </li>
      </ol>
      <div className="rounded-md bg-muted/50 p-2.5">
        <p className="mb-1.5 text-xs text-muted-foreground">
          Prefer editing config directly? Set this in{" "}
          <span className="font-mono">~/.config/cmux/cmux.json</span>:
        </p>
        <div className="flex items-center justify-between gap-2">
          <code className="truncate font-mono text-xs">
            "automation": {"{"} "socketControlMode": "{RECOMMENDED_MODE}" {"}"}
          </code>
          <CopyButton value={`"socketControlMode": "${RECOMMENDED_MODE}"`} />
        </div>
      </div>
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
      Open the cmux app, then try opening the chat again.
    </DialogDescription>
  );
}

// Shown when a "open/start chat in cmux" command comes back rejected. The two
// reasons map to distinct guidance; the dialog is controlled by the launcher.
export function CmuxAccessDialog({
  open,
  onOpenChange,
  reason,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: CmuxAccessReason;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {reason === "cmux-access-denied"
              ? "Let Hitch control cmux"
              : "cmux isn’t running"}
          </DialogTitle>
        </DialogHeader>
        {reason === "cmux-access-denied" ? (
          <AccessDeniedBody />
        ) : (
          <UnavailableBody />
        )}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
