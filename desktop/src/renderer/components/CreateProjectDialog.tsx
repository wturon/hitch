"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Extracted from AppSidebar (V1) so V2 can reuse it without dragging the
// Convex-backed sidebar module into the bundle. Convex-free by construction.
export function CreateProjectDialog({
  open,
  onOpenChange,
  creating,
  onCreate,
  initialName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creating: boolean;
  onCreate: (name: string) => Promise<void>;
  // Pre-fills the field when opened — the command palette passes the typed query
  // for its "New project “<query>”" create row.
  initialName?: string;
}) {
  const [name, setName] = useState(initialName ?? "");

  // Re-seed the field each time the dialog opens (the palette may carry a fresh
  // query); also clears it after a create closes the dialog.
  useEffect(() => {
    if (open) setName(initialName ?? "");
  }, [open, initialName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await onCreate(trimmed);
    setName("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Create a project and switch to its board.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <label className="sr-only" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
