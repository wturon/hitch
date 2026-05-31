"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CopyIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DaemonTokens({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && <DaemonTokensContent workspace={workspace} />}
      </DialogContent>
    </Dialog>
  );
}

function DaemonTokensContent({ workspace }: { workspace: string }) {
  const tokens = useQuery(api.daemonTokens.list, { workspace });
  const createToken = useMutation(api.daemonTokens.create);
  const revokeToken = useMutation(api.daemonTokens.revoke);
  const [name, setName] = useState("Local daemon");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<Id<"daemonTokens"> | null>(null);
  const [creating, setCreating] = useState(false);
  const activeTokens =
    tokens?.filter((token) => token.revokedAt === undefined) ?? [];

  async function create() {
    const tokenName = name.trim() || "Local daemon";
    setCreating(true);
    try {
      const result = await createToken({ workspace, name: tokenName });
      setCreatedToken(result.token);
      setName(tokenName);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: Id<"daemonTokens">) {
    setBusyId(id);
    try {
      await revokeToken({ workspace, id });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Daemon tokens</DialogTitle>
      </DialogHeader>

      <section className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Token name
        </label>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button onClick={create} disabled={creating}>
            <PlusIcon />
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </section>

      {createdToken && (
        <section className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            New token
          </label>
          <textarea
            readOnly
            value={createdToken}
            className="h-20 resize-none rounded-md border bg-transparent p-2 font-mono text-xs outline-none"
          />
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void navigator.clipboard.writeText(createdToken)}
          >
            <CopyIcon />
            Copy
          </Button>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Active
        </h3>
        {tokens === undefined ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : activeTokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active tokens.</p>
        ) : (
          activeTokens.map((token) => (
            <div
              key={token._id}
              className="flex items-center gap-2 rounded-md border p-2"
            >
              <KeyRoundIcon className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{token.name}</p>
                <p className="text-xs text-muted-foreground">
                  Last used{" "}
                  {token.lastUsedAt
                    ? new Date(token.lastUsedAt).toLocaleString()
                    : "never"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Revoke token"
                disabled={busyId === token._id}
                onClick={() => void revoke(token._id)}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))
        )}
      </section>

      <DialogFooter />
    </>
  );
}
