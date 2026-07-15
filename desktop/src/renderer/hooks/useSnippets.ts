"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export type Snippet = {
  id: string;
  name: string;
  body: string;
};

// The current user's snippets, sorted by name. Returns `[]` while loading or
// when signed out (the query itself returns [] rather than throwing).
export function useSnippets(): ReadonlyArray<Snippet> {
  const rows = useQuery(api.snippets.list, {});

  return useMemo(
    () =>
      (rows ?? [])
        .map((row) => ({ id: row._id, name: row.name, body: row.body }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  );
}
