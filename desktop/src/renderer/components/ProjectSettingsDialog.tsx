"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { FolderOpenIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Per-project settings: the name, and the WORKING DIRECTORY agents start in.
//
// The working directory is optional on purpose. It used to matter more, when
// projects were folders of markdown Hitch synced; now the server owns the tasks
// and a path only says "this project is also a checkout over here" — true for
// some projects and meaningless for others. Left empty, agents start in the
// home folder, which is what every project does today.
//
// Setting it is what gives an agent the repo context you'd expect it to have:
// the daemon passes it as the spawn cwd (daemon/src/v2/reconciler.ts), and the
// chat observer uses it to attribute a running chat back to its project.

interface DirectoryBridge {
  chooseDirectory?: (defaultPath?: string) => Promise<string | null>;
  getHomeDir?: () => Promise<string>;
  directoryExists?: (path: string) => Promise<boolean>;
}

function bridge(): DirectoryBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { hitchDaemon?: DirectoryBridge }).hitchDaemon;
}

export interface ProjectSettingsTarget {
  id: string;
  name: string;
  repoPath: string | null;
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onSave,
}: {
  // Null while no project is being edited (the dialog is a single mount).
  project: ProjectSettingsTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Persists the patch. Throwing surfaces the message and keeps the dialog open
  // so the edit isn't lost.
  onSave: (patch: { name: string; repoPath: string | null }) => Promise<void>;
}) {
  const nameId = useId();
  const pathId = useId();
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  // Re-seed from the project each time the dialog opens, so a cancelled edit
  // never leaks into the next one.
  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setRepoPath(project.repoPath ?? "");
    setError(null);
  }, [open, project]);

  // The real fallback path, shown rather than described — "your home folder" is
  // vaguer than the path itself, and this is the value the daemon will use.
  useEffect(() => {
    if (!open || homeDir !== null) return;
    void bridge()
      ?.getHomeDir?.()
      .then((dir) => setHomeDir(dir))
      .catch(() => {});
  }, [open, homeDir]);

  // A typo'd path doesn't fail here — it fails much later, as an assignment
  // that dies with no obvious cause. So check it, but only WARN: the path is
  // stored on the project, and the machine that runs the agent may not be this
  // one. Browsing always yields a real directory, so this only fires on typing.
  useEffect(() => {
    const path = repoPath.trim();
    if (!path) {
      setMissing(false);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void bridge()
        ?.directoryExists?.(path)
        .then((exists) => {
          if (active) setMissing(!exists);
        })
        .catch(() => {});
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [repoPath]);

  async function browse() {
    const chosen = await bridge()?.chooseDirectory?.(repoPath.trim() || undefined);
    if (chosen) setRepoPath(chosen);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Empty → null, not "": null is "unset" everywhere else in this column,
      // and the daemon's fallback tests for a blank string anyway.
      await onSave({ name: trimmedName, repoPath: repoPath.trim() || null });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Rename the project and choose where its agents start.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={nameId}
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Name
            </label>
            <input
              id={nameId}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={pathId}
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Working directory
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              Agents delegated to this project start here, so they can see the
              code and files you'd expect. Optional — leave it empty and they
              start in{" "}
              <code className="font-mono">{homeDir ?? "your home folder"}</code>.
            </p>
            <div className="flex items-center gap-2">
              <input
                id={pathId}
                value={repoPath}
                onChange={(event) => setRepoPath(event.target.value)}
                placeholder={homeDir ?? "/Users/you/code/project"}
                spellCheck={false}
                className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 gap-1.5"
                onClick={() => void browse()}
              >
                <FolderOpenIcon className="size-3.5" />
                Browse…
              </Button>
            </div>
            {missing && (
              <p className="text-xs text-muted-foreground">
                No such folder on this Mac. Saving anyway is fine if it exists on
                the machine you delegate to.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
