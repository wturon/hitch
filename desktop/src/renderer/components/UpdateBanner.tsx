"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircleIcon,
  DownloadIcon,
  Loader2Icon,
  RotateCwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdaterStatus {
  enabled: boolean;
  phase: UpdaterPhase;
  currentVersion: string;
  version: string | null;
  percent: number | null;
  error: string | null;
}

interface UpdaterApi {
  getUpdaterStatus: () => Promise<UpdaterStatus>;
  checkForUpdates: () => Promise<UpdaterStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => () => void;
}

function updaterBridge(): UpdaterApi | undefined {
  return typeof window !== "undefined"
    ? (window.hitchDaemon as unknown as UpdaterApi | undefined)
    : undefined;
}

// Shared updater state for both the sidebar banner and the settings dialog: it
// seeds from the current main-process status, then live-updates as the
// autoUpdater emits events. `present` is false outside the desktop shell.
export function useUpdater() {
  const bridge = updaterBridge();
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getUpdaterStatus().then(setStatus);
    return bridge.onUpdaterStatus(setStatus);
  }, [bridge]);

  const check = useCallback(() => {
    void bridge?.checkForUpdates().then(setStatus);
  }, [bridge]);
  const download = useCallback(() => {
    void bridge?.downloadUpdate();
  }, [bridge]);
  const install = useCallback(() => {
    void bridge?.installUpdate();
  }, [bridge]);

  return { present: Boolean(bridge), status, check, download, install };
}

const labelVersion = (version: string | null) =>
  version ? `v${version}` : "new version";

// A compact sidebar entry that only appears when there's something to act on:
// an available update to download, a download in progress, a downloaded update
// ready to install, or an error to retry. Styled to sit in the sidebar's
// bottom action stack alongside the other buttons.
export function UpdateBanner() {
  const { status, check, download, install } = useUpdater();
  if (!status) return null;

  const { phase, version, percent } = status;

  if (phase === "available") {
    return (
      <Button
        size="sm"
        onClick={download}
        aria-label={`Download Hitch ${labelVersion(version)}`}
        className="justify-start md:w-full"
      >
        <DownloadIcon />
        <span className="hidden md:inline">Update to {labelVersion(version)}</span>
      </Button>
    );
  }

  if (phase === "downloading") {
    return (
      <Button
        size="sm"
        disabled
        aria-label="Downloading update"
        className="justify-start md:w-full"
      >
        <Loader2Icon className="animate-spin" />
        <span className="hidden md:inline">
          Downloading… {percent ?? 0}%
        </span>
      </Button>
    );
  }

  if (phase === "downloaded") {
    return (
      <Button
        size="sm"
        onClick={install}
        aria-label={`Restart to install Hitch ${labelVersion(version)}`}
        className="justify-start md:w-full"
      >
        <RotateCwIcon />
        <span className="hidden md:inline">Restart to update</span>
      </Button>
    );
  }

  if (phase === "error") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={check}
        aria-label="Retry update check"
        className="justify-start text-amber-600 hover:bg-sidebar-accent dark:text-amber-400 md:w-full"
      >
        <AlertCircleIcon />
        <span className="hidden md:inline">Update failed — retry</span>
      </Button>
    );
  }

  // idle / checking / up-to-date: nothing actionable to show in the sidebar.
  return null;
}
