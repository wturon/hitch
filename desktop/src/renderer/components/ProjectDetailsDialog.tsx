"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  CalendarIcon,
  HashIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function ProjectDetailsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const details = useQuery(api.projects.details, open ? { project } : "skip");
  const updateDetails = useMutation(api.projects.updateDetails);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!details?.project) return;
    setName(details.project.name);
    setError(null);
  }, [details?.project]);

  const canEdit = details?.membership?.role === "owner";
  const trimmedName = name.trim();
  const hasNameChange =
    Boolean(details?.project) && trimmedName !== details?.project.name;

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details?.project || !canEdit || !trimmedName || !hasNameChange) return;

    setSaving(true);
    setError(null);
    try {
      await updateDetails({ project, name: trimmedName });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Project details</DialogTitle>
          <DialogDescription>
            {details?.project?.slug ?? project}
          </DialogDescription>
        </DialogHeader>

        {details === undefined ? (
          <div className="py-8 text-sm text-muted-foreground">
            Loading project...
          </div>
        ) : details === null ? (
          <div className="py-8 text-sm text-muted-foreground">
            Project details are not available.
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={saveProject}>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Title
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!canEdit || saving}
                className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <HashIcon className="size-3.5" />
                  Slug
                </div>
                <p className="mt-1 truncate text-sm font-medium">
                  {details.project.slug}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ShieldCheckIcon className="size-3.5" />
                  Your role
                </div>
                <p className="mt-1 capitalize text-sm font-medium">
                  {details.membership?.role ?? "member"}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <CalendarIcon className="size-3.5" />
                  Created
                </div>
                <p className="mt-1 text-sm font-medium">
                  {formatDate(details.project.createdAt)}
                </p>
              </div>
            </div>

            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <UsersIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">
                  Members ({details.members.length})
                </h3>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {details.members.map((member) => {
                  const displayName =
                    member.user?.name ?? member.user?.email ?? "Unknown member";
                  const email =
                    member.user?.email && member.user.email !== displayName
                      ? member.user.email
                      : null;
                  return (
                    <div
                      key={member.membershipId}
                      className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                    >
                      {member.user?.image ? (
                        <img
                          src={member.user.image}
                          alt=""
                          className="size-8 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                          {initials(displayName) || "?"}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {displayName}
                        </p>
                        {email && (
                          <p className="truncate text-xs text-muted-foreground">
                            {email}
                          </p>
                        )}
                      </div>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                        {member.role}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                type="submit"
                disabled={!canEdit || saving || !trimmedName || !hasNameChange}
              >
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
