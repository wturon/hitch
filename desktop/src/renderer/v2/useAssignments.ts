import { useQuery } from "@tanstack/react-query";

import type { HitchClient } from "@/lib/server/client";

// The V2 delegate bar's read path (M4 PR 5). Two coarse queries keyed to match
// the WS invalidation map (lib/server/queryKeys.ts): a `chats`/`assignments`
// table NOTIFY invalidates ["assignments"], and a `machines` NOTIFY invalidates
// ["machines"], so both refetch live as the daemon writes observations.

// Assignments for one task (the append-only history — the bar picks the latest
// itself). Disabled until the task exists on the server (a fresh capture has no
// id to query against).
export function useAssignments(client: HitchClient, taskId: string | null) {
  return useQuery({
    queryKey: ["assignments", { taskId }],
    queryFn: async () => {
      const response = await client.assignments.$get({
        query: { task_id: taskId! },
      });
      if (!response.ok) {
        throw new Error(`Failed to list assignments (${response.status})`);
      }
      return await response.json();
    },
    enabled: taskId !== null,
  });
}

// The user's machines, so the bar can pick a spawn target (GET /machines is
// read-only; the daemon registers + heartbeats them). One query for the whole
// bar — staleness is derived client-side against last_seen_at.
export function useMachines(client: HitchClient) {
  return useQuery({
    queryKey: ["machines"],
    queryFn: async () => {
      const response = await client.machines.$get();
      if (!response.ok) {
        throw new Error(`Failed to list machines (${response.status})`);
      }
      return await response.json();
    },
  });
}

export type AssignmentRow = NonNullable<
  ReturnType<typeof useAssignments>["data"]
>[number];
export type MachineRow = NonNullable<
  ReturnType<typeof useMachines>["data"]
>[number];
