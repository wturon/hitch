import { useCallback, useEffect, useState } from "react";

// Local-only loop state, owned by the Electron main process and persisted in
// preferences.json (never synced — a synced loop definition must not silently
// run on another machine). This hook is the renderer's view of it: the enabled
// flag and trusted trigger-script hashes for every loop in a project. `trusted`
// maps a script path (rel to .hitch/) to its trusted SHA-256.
export interface LoopLocalState {
  enabled: boolean;
  trusted: Record<string, string>;
}
export type ProjectLoopStates = Record<string, LoopLocalState>;

interface LoopBridge {
  getLoopStates: (projectId: string) => Promise<ProjectLoopStates>;
  setLoopEnabled: (
    projectId: string,
    loopPath: string,
    enabled: boolean,
  ) => Promise<ProjectLoopStates>;
  setLoopTrust: (
    projectId: string,
    loopPath: string,
    scriptPath: string,
    sha256: string,
  ) => Promise<ProjectLoopStates>;
  clearLoopTrust: (
    projectId: string,
    loopPath: string,
    scriptPath: string,
  ) => Promise<ProjectLoopStates>;
}

function loopBridge(): LoopBridge | undefined {
  return typeof window !== "undefined"
    ? (window.hitchDaemon as unknown as LoopBridge | undefined)
    : undefined;
}

const EMPTY_LOOP_STATE: LoopLocalState = { enabled: false, trusted: {} };

export interface LoopLocalStateApi {
  states: ProjectLoopStates;
  loaded: boolean;
  stateFor: (loopPath: string) => LoopLocalState;
  setEnabled: (loopPath: string, enabled: boolean) => Promise<void>;
  setTrust: (
    loopPath: string,
    scriptPath: string,
    sha256: string,
  ) => Promise<void>;
  clearTrust: (loopPath: string, scriptPath: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useLoopLocalState(
  projectId: string | null,
): LoopLocalStateApi {
  const [states, setStates] = useState<ProjectLoopStates>({});
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = loopBridge();
    if (!bridge || !projectId) {
      setStates({});
      setLoaded(true);
      return;
    }
    setStates(await bridge.getLoopStates(projectId));
    setLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (loopPath: string, enabled: boolean) => {
      const bridge = loopBridge();
      if (!bridge || !projectId) return;
      setStates(await bridge.setLoopEnabled(projectId, loopPath, enabled));
    },
    [projectId],
  );

  const setTrust = useCallback(
    async (loopPath: string, scriptPath: string, sha256: string) => {
      const bridge = loopBridge();
      if (!bridge || !projectId) return;
      setStates(await bridge.setLoopTrust(projectId, loopPath, scriptPath, sha256));
    },
    [projectId],
  );

  const clearTrust = useCallback(
    async (loopPath: string, scriptPath: string) => {
      const bridge = loopBridge();
      if (!bridge || !projectId) return;
      setStates(await bridge.clearLoopTrust(projectId, loopPath, scriptPath));
    },
    [projectId],
  );

  const stateFor = useCallback(
    (loopPath: string): LoopLocalState => states[loopPath] ?? EMPTY_LOOP_STATE,
    [states],
  );

  return {
    states,
    loaded,
    stateFor,
    setEnabled,
    setTrust,
    clearTrust,
    refresh,
  };
}
