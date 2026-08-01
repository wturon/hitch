import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { HitchClient } from "@/lib/server/client";
import type { AssignmentRow } from "./useAssignments";

// Ack an attention item (done ∧ unreviewed): stamp reviewed_at so the row's
// chip drops from amber back to idle. Optimistic — patch the ["assignments"]
// cache so the chip clears in the same render, then invalidate for server truth.
//
// Extracted from TodosView when the cross-project "All tasks" view arrived:
// both lists render the SAME row, whose context menu carries "Mark reviewed",
// so both need this write. Duplicating an optimistic mutation is how two
// surfaces end up rolling back differently from the same failure.
//
// Returns the one callback the row's `RowActions.onAck` wants, not the mutation
// object — nothing on either surface reads its pending/error state (the failure
// path is a rollback plus a console line, exactly as it was).
export function useAckAssignment(
  client: HitchClient,
): (assignmentId: string) => void {
  const queryClient = useQueryClient();

  const { mutate } = useMutation({
    mutationFn: async (assignmentId: string) => {
      const response = await client.assignments[":id"].$patch({
        param: { id: assignmentId },
        json: { reviewedAt: new Date().toISOString() },
      });
      if (!response.ok) throw new Error(`Failed to ack assignment (${response.status})`);
    },
    onMutate: async (assignmentId) => {
      await queryClient.cancelQueries({ queryKey: ["assignments"] });
      // The FULL row type, not the narrow AttentionAssignment: the chip reads
      // harness/chatId/machineId out of this same cache entry, so typing the
      // optimistic write narrowly would invite a rewrite that quietly drops
      // them and blanks every chip until the next refetch.
      const previous = queryClient.getQueryData<AssignmentRow[]>(["assignments"]);
      queryClient.setQueryData<AssignmentRow[]>(["assignments"], (old) =>
        old?.map((a) =>
          a.id === assignmentId ? { ...a, reviewedAt: new Date().toISOString() } : a,
        ),
      );
      return { previous };
    },
    onError: (error, _id, context) => {
      console.error("Failed to ack attention item; rolling back", error);
      if (context?.previous !== undefined) {
        queryClient.setQueryData(["assignments"], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
  });

  return useCallback((assignmentId: string) => mutate(assignmentId), [mutate]);
}
