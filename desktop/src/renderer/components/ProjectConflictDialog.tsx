"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProjectConflict } from "@/components/LocalSyncDialog";

// Surfaces folders the daemon refused to sync because their .hitch/project.json
// points at a different project than this Hitch environment's config binds them
// to — the dev⇄prod "shared folder, different deployment" case. Overriding
// rewrites project.json's projectId and resumes syncing (union of local ∪
// server). Self-mounted once at the app root; hides itself when there are no
// conflicts or when running outside Hitch Desktop.
export function ProjectConflictDialog() {
  const bridge = typeof window !== "undefined" ? window.hitchDaemon : undefined;
  const [conflicts, setConflicts] = useState<ProjectConflict[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getState().then((state) => setConflicts(state.conflicts));
    return bridge.onState((state) => setConflicts(state.conflicts));
  }, [bridge]);

  const conflict = conflicts[0] ?? null;

  async function override(target: ProjectConflict) {
    if (!bridge) return;
    setResolving(target.projectId);
    setError(null);
    try {
      const state = await bridge.resolveProjectConflict(target.projectId);
      setConflicts(state.conflicts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(null);
    }
  }

  if (!bridge || !conflict) return null;

  const label = conflict.projectName || conflict.projectId;
  const remaining = conflicts.length - 1;

  return (
    // Controlled open with no onOpenChange: the dialog can't close itself, so an
    // outside click or Esc won't leave the folder silently stuck unresolved.
    <Dialog open>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Project ID mismatch</DialogTitle>
          <DialogDescription>
            This folder&apos;s <code>.hitch/project.json</code> belongs to a
            different project than this Hitch environment expects, so it
            isn&apos;t syncing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="truncate font-medium" title={conflict.localPath}>
              {conflict.localPath}
            </p>
            <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
              <dt className="text-muted-foreground">On disk</dt>
              <dd className="truncate font-mono" title={conflict.diskProjectId}>
                {conflict.diskProjectId}
              </dd>
              <dt className="text-muted-foreground">This project</dt>
              <dd className="truncate font-mono" title={conflict.projectId}>
                {conflict.projectId}
              </dd>
            </dl>
          </div>
          <p className="text-muted-foreground">
            Override the local <code>project.json</code> to point at{" "}
            <span className="font-medium text-foreground">{label}</span> and
            start syncing? Local tasks are kept and merged with whatever already
            exists on the server — nothing is deleted.
          </p>
          {error && <p className="text-destructive">{error}</p>}
        </div>

        <DialogFooter className="sm:justify-between">
          <span className="self-center text-xs text-muted-foreground">
            {remaining > 0
              ? `${remaining} more folder${remaining > 1 ? "s" : ""} to resolve`
              : ""}
          </span>
          <Button
            type="button"
            disabled={resolving !== null}
            onClick={() => void override(conflict)}
          >
            {resolving === conflict.projectId ? "Overriding…" : "Override and sync"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
