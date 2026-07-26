import { useQuery } from "@tanstack/react-query";

import type { HitchClient } from "@/lib/server/client";

// A project's sections — the user-created structure of its list.
//
// The key is ["sections", { projectId }] so the coarse per-table WS
// invalidation reaches it by prefix: queryKeys.ts already maps the `sections`
// table onto ["sections"], and migration 0001 already installs the NOTIFY
// trigger. Both have been in place since M1 with nothing reading them.
export function useSections(client: HitchClient, projectId: string) {
  return useQuery({
    queryKey: ["sections", { projectId }],
    queryFn: () => fetchSections(client, projectId),
  });
}

// Exported so any other surface that needs a project's sections (the move-to
// submenu, a future palette) shares this EXACT queryFn under the same key —
// one cache entry, one live truth.
export async function fetchSections(client: HitchClient, projectId: string) {
  const response = await client.sections.$get({ query: { project_id: projectId } });
  if (!response.ok) throw new Error(`Failed to list sections (${response.status})`);
  return await response.json();
}

export type SectionItem = Awaited<ReturnType<typeof fetchSections>>[number];
