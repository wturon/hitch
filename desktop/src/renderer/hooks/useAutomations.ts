"use client";

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import {
  automationFileForPath,
  automationPath,
  contentFromDraft,
  defaultAutomationDraft,
  defaultAutomationContent,
  draftFromContent,
  nextAutomationSlug,
  type AutomationDefinitionDraft,
  type AutomationFileDoc,
} from "@/lib/automations";

export function useAutomationDefinitions(
  projectId: Id<"projects"> | null | undefined,
  options: { includeInvalid?: boolean } = {},
) {
  const result = useQuery(
    api.automations.listAutomations,
    projectId
      ? {
          projectId,
          ...(options.includeInvalid ? { includeInvalid: true } : {}),
        }
      : "skip",
  );

  return useMemo(
    () => ({
      loading: projectId !== null && projectId !== undefined && result === undefined,
      automations: result ?? [],
    }),
    [projectId, result],
  );
}

export function useAutomationRuns(
  projectId: Id<"projects"> | null | undefined,
  automationPathValue: string | null | undefined,
  limit = 10,
) {
  const result = useQuery(
    api.automations.listRuns,
    projectId && automationPathValue
      ? { projectId, automationPath: automationPathValue, limit }
      : "skip",
  );

  return useMemo(
    () => ({
      loading:
        projectId !== null &&
        projectId !== undefined &&
        automationPathValue !== null &&
        automationPathValue !== undefined &&
        result === undefined,
      runs: result ?? [],
    }),
    [automationPathValue, projectId, result],
  );
}

export function useAutomationActions(
  projectId: Id<"projects">,
  files: AutomationFileDoc[],
) {
  const upsertFile = useMutation(api.files.upsertFile).withOptimisticUpdate(
    (localStore, args) => {
      const existing = localStore.getQuery(api.files.listFiles, {
        projectId: args.projectId,
      });
      if (existing === undefined) return;
      type FileRow = (typeof existing)[number];
      const idx = existing.findIndex((file) => file.path === args.path);
      const base: FileRow =
        idx >= 0
          ? existing[idx]
          : ({
              _id: `optimistic:${args.path}` as FileRow["_id"],
              _creationTime: Number.MAX_SAFE_INTEGER,
              projectId: "" as FileRow["projectId"],
              path: args.path,
              content: "",
              hash: "",
              deleted: false,
              updatedAt: Number.MAX_SAFE_INTEGER,
            } satisfies FileRow);
      const patched: FileRow = {
        ...base,
        content: args.content,
        hash: args.hash,
        deleted: args.deleted,
        updatedAt: Number.MAX_SAFE_INTEGER,
      };
      const next =
        idx >= 0
          ? existing.map((file, i) => (i === idx ? patched : file))
          : [...existing, patched];
      localStore.setQuery(api.files.listFiles, { projectId: args.projectId }, next);
    },
  );
  const runNowMutation = useMutation(api.automations.runNow);

  return useMemo(
    () => ({
      createAutomation: async (
        name: string,
        draft?: Partial<AutomationDefinitionDraft>,
      ) => {
        const baseDraft = { ...defaultAutomationDraft(name), ...draft };
        const cleanName = baseDraft.name.trim() || "Untitled automation";
        const slug = nextAutomationSlug(files, cleanName);
        const path = automationPath(slug);
        const content = draft
          ? contentFromDraft(defaultAutomationContent(cleanName, baseDraft.timezone), {
              ...baseDraft,
              name: cleanName,
            })
          : defaultAutomationContent(cleanName);
        await upsertFile({
          projectId,
          path,
          content,
          hash: await sha256(content),
          deleted: false,
        });
        return path;
      },
      updateAutomation: async (
        path: string,
        draft: AutomationDefinitionDraft,
      ) => {
        const file = automationFileForPath(files, path);
        if (!file) throw new Error("Automation source file not found");
        const content = contentFromDraft(file.content, draft);
        await upsertFile({
          projectId,
          path,
          content,
          hash: await sha256(content),
          deleted: false,
        });
      },
      setEnabled: async (path: string, enabled: boolean) => {
        const file = automationFileForPath(files, path);
        if (!file) throw new Error("Automation source file not found");
        const content = contentFromDraft(file.content, {
          ...draftFromContent(file.content),
          enabled,
        });
        await upsertFile({
          projectId,
          path,
          content,
          hash: await sha256(content),
          deleted: false,
        });
      },
      deleteAutomation: async (path: string) => {
        const file = automationFileForPath(files, path);
        await upsertFile({
          projectId,
          path,
          content: file?.content ?? "",
          hash: await sha256(file?.content ?? ""),
          deleted: true,
        });
      },
      runNow: (automationPathValue: string) =>
        runNowMutation({ projectId, automationPath: automationPathValue }),
    }),
    [files, projectId, runNowMutation, upsertFile],
  );
}
