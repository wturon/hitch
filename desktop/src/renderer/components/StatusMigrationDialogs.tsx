"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ArchiveIcon,
  Loader2Icon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectStatus } from "@/lib/projectConfig";
import {
  statusCardCountLabel,
  statusFrontmatterLine,
  uniqueStatusId,
} from "@/lib/statuses";
import { cn } from "@/lib/utils";

export type RenameStatusMigrationRequest = {
  kind: "rename";
  status: ProjectStatus;
  initialName: string;
  cardCount: number;
  statuses: ProjectStatus[];
  onConfirm: (name: string) => Promise<void>;
};

export type DeleteStatusMigrationRequest = {
  kind: "delete";
  status: ProjectStatus;
  cardCount: number;
  statuses: ProjectStatus[];
  onConfirm: (destinationStatusId: string) => Promise<void>;
};

export type MoveStatusMigrationRequest = {
  kind: "move";
  status: ProjectStatus;
  cardCount: number;
  statuses: ProjectStatus[];
  onConfirm: (destinationStatusId: string) => Promise<void>;
};

export type StatusMigrationRequest =
  | RenameStatusMigrationRequest
  | DeleteStatusMigrationRequest
  | MoveStatusMigrationRequest;

const ARCHIVE_DESTINATION = "archived";

function affectedCopy(count: number, fromId: string, toId: string) {
  return (
    <>
      {statusCardCountLabel(count)} will be updated from{" "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {statusFrontmatterLine(fromId)}
      </code>{" "}
      to{" "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {statusFrontmatterLine(toId)}
      </code>
      .
    </>
  );
}

function StatusIdTransition({
  fromId,
  toId,
}: {
  fromId: string;
  toId: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/35 px-2.5 py-2 font-mono text-xs">
      <span className="min-w-0 truncate">{fromId}</span>
      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-semibold text-foreground">
        {toId || "status"}
      </span>
    </div>
  );
}

function MigrationCallout({
  count,
  fromId,
  toId,
  children,
}: {
  count: number;
  fromId: string;
  toId: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-muted/35 p-3 text-sm leading-5">
      <p>{affectedCopy(count, fromId, toId)}</p>
      {children}
    </div>
  );
}

function destinationLabel(destination: string | null) {
  if (destination === ARCHIVE_DESTINATION) return "Archive the card instead";
  return "Choose destination";
}

export function StatusMigrationDialog({
  request,
  onClose,
}: {
  request: StatusMigrationRequest | null;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [destinationStatusId, setDestinationStatusId] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftName(request?.kind === "rename" ? request.initialName : "");
    setDestinationStatusId(null);
    setBusy(false);
    setError(null);
  }, [request]);

  const renameToId = useMemo(() => {
    if (request?.kind !== "rename") return "";
    return uniqueStatusId(
      draftName,
      request.statuses.filter((status) => status.id !== request.status.id),
    );
  }, [draftName, request]);

  const destinationStatus = useMemo(() => {
    if (
      (request?.kind !== "delete" && request?.kind !== "move") ||
      destinationStatusId === null
    ) {
      return null;
    }
    return (
      request.statuses.find((status) => status.id === destinationStatusId) ??
      null
    );
  }, [destinationStatusId, request]);

  if (request === null) return null;
  const activeRequest = request;

  const trimmedName = draftName.trim().replace(/\s+/g, " ");
  const confirmDisabled =
    busy ||
    (activeRequest.kind === "rename"
      ? trimmedName.length === 0 || trimmedName === activeRequest.status.name
      : destinationStatusId === null);
  const confirmLabel =
    activeRequest.kind === "rename"
      ? `Rename & update ${statusCardCountLabel(activeRequest.cardCount)}`
      : activeRequest.kind === "move"
        ? destinationStatusId === ARCHIVE_DESTINATION
          ? `Archive ${statusCardCountLabel(activeRequest.cardCount)}`
          : `Move ${statusCardCountLabel(activeRequest.cardCount)}`
      : destinationStatusId === ARCHIVE_DESTINATION
        ? `Delete & archive ${statusCardCountLabel(activeRequest.cardCount)}`
        : `Delete & move ${statusCardCountLabel(activeRequest.cardCount)}`;

  async function confirm() {
    if (confirmDisabled) return;
    setBusy(true);
    setError(null);
    try {
      if (activeRequest.kind === "rename") {
        await activeRequest.onConfirm(trimmedName);
      } else if (destinationStatusId !== null) {
        await activeRequest.onConfirm(destinationStatusId);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {request.kind === "rename"
              ? "Rename status"
              : request.kind === "move"
                ? "Move cards from unknown status"
                : `Delete "${request.status.name}"?`}
          </DialogTitle>
          <DialogDescription>
            {request.kind === "rename"
              ? "Rename the status and update every card that uses its current id."
              : request.kind === "move"
                ? "Choose a configured status for these cards."
              : "Choose where the cards go before the status is removed."}
          </DialogDescription>
        </DialogHeader>

        {request.kind === "rename" ? (
          <div className="grid gap-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Name
              </span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                disabled={busy}
                className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                autoFocus
              />
            </label>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                ID
              </span>
              <StatusIdTransition fromId={request.status.id} toId={renameToId} />
            </div>

            <MigrationCallout
              count={request.cardCount}
              fromId={request.status.id}
              toId={renameToId}
            >
              <p className="mt-2 flex gap-2 text-muted-foreground">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  Automations or notes that mention{" "}
                  <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]">
                    {request.status.id}
                  </code>{" "}
                  by name will not be updated automatically.
                </span>
              </p>
            </MigrationCallout>
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm leading-5">
              {request.cardCount === 1 ? "1 card uses" : `${request.cardCount} cards use`}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {statusFrontmatterLine(request.status.id)}
              </code>
              .{" "}
              {request.kind === "move"
                ? "Choose where it should go."
                : "Hitch will not move cards on its own."}
            </p>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Move cards to
              </span>
              <Select
                value={destinationStatusId}
                onValueChange={(value) =>
                  setDestinationStatusId(value as string)
                }
              >
                <SelectTrigger
                  aria-label="Move cards to"
                  disabled={busy}
                  className={cn(
                    "h-10 w-full justify-between bg-background",
                    destinationStatusId === null && "text-muted-foreground",
                  )}
                >
                  <SelectValue>
                    {(value: string | null) =>
                      value === ARCHIVE_DESTINATION
                        ? "Archive the card instead"
                        : request.statuses.find((status) => status.id === value)
                            ?.name ?? destinationLabel(value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-[18rem]">
                  {request.statuses
                    .filter(
                      (status) =>
                        request.kind !== "delete" ||
                        status.id !== request.status.id,
                    )
                    .map((status) => (
                      <SelectItem key={status.id} value={status.id}>
                        <span className="min-w-0 flex-1 truncate">
                          {status.name}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {status.id}
                        </span>
                      </SelectItem>
                    ))}
                  <div className="my-1 h-px bg-border" />
                  <SelectItem value={ARCHIVE_DESTINATION}>
                    <ArchiveIcon className="size-3.5 shrink-0" />
                    <span>Archive the card instead</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      archived
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </label>

            {destinationStatusId !== null && (
              <MigrationCallout
                count={request.cardCount}
                fromId={request.status.id}
                toId={destinationStatusId}
              >
                {destinationStatus && (
                  <p className="mt-1 text-muted-foreground">
                    Cards will land in {destinationStatus.name}.
                  </p>
                )}
              </MigrationCallout>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={confirmDisabled}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            {busy ? "Updating…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
