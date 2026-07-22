import { useCallback, useReducer, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { sha256Bytes } from "@/lib/hash";
import type { HitchClient } from "@/lib/server/client";
import {
  attachmentMarkdown,
  createUrlCache,
  initialUploadState,
  isImageMime,
  pickAttachmentName,
  resolveAttachmentRef,
  uploadReducer,
  type UploadKind,
} from "./attachmentModel";

// The V2 attachments data layer (M2 PR 6) — the server-backed successor to
// V1's hooks/useAttachments.ts, same shape on purpose so TaskDialogV2 wires it
// into the SAME editor seams (imageUploadHandler / imagePreviewHandler) V1
// uses. What changed underneath:
//
//   • upload = the PRD's presigned three-step, renderer-direct: POST
//     /attachments (row state='pending' + presigned PUT url) → PUT the bytes
//     straight to the bucket (bucket CORS is configured by the compose
//     sidecar; no main-process fallback needed) → POST /:id/finalize (server
//     HEADs the object and enforces the size cap). The markdown ref is only
//     returned once finalize lands, so a reference never enters the body
//     without a finalized row behind it (V1's register-before-return rule).
//   • preview = resolve the body's relative `attachments/<name>` ref against
//     the task's attachment rows BY ROW FILENAME (see attachmentModel), then
//     mint a presigned GET via /:id/download — cached for ~4 of its 5 minutes
//     so a burst of renders doesn't stampede the endpoint, and a reload after
//     expiry re-mints instead of serving a dead URL.
//
// Same single-ingress design as V1: the editor's image paste and the
// dialog-level file drop share one hook instance — one in-flight counter, one
// name-reservation set, one rows query — so a paste and a drop can't race
// into the same filename. Handlers are stable (the editor reads them once);
// every moving part is read through a ref.
export function useAttachmentsV2(client: HitchClient, taskId: string | null) {
  const queryClient = useQueryClient();
  const rowsQuery = useQuery({
    queryKey: ["attachments", { taskId }],
    queryFn: async () => {
      const response = await client.attachments.$get({
        query: { task_id: taskId! },
      });
      if (!response.ok) {
        throw new Error(`Failed to list attachments (${response.status})`);
      }
      return await response.json();
    },
    enabled: taskId !== null,
  });

  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const rows = rowsQuery.data;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Names handed out this session but not yet visible in `rows` (the query
  // lags a create), so concurrent uploads — incl. a multi-file drop — can't
  // pick the same name (V1's reservation set).
  const reservedRef = useRef<Set<string>>(new Set());
  const [uploadState, dispatch] = useReducer(uploadReducer, initialUploadState);
  // Presigned GET cache + in-flight dedup, per hook instance (per dialog
  // session): every ImageNode for the same attachment shares one URL fetch.
  const urlCacheRef = useRef(createUrlCache());
  const inflightUrlRef = useRef<Map<string, Promise<string>>>(new Map());

  // Pick a unique filename within the task's attachment set, reserving it.
  const reserveName = useCallback(
    (file: File, kind: UploadKind): string => {
      const taken = new Set<string>(reservedRef.current);
      for (const row of rowsRef.current ?? []) taken.add(row.filename);
      const name = pickAttachmentName(kind, file, taken);
      reservedRef.current.add(name);
      return name;
    },
    [],
  );

  const uploadOne = useCallback(
    async (file: File, kind: UploadKind) => {
      const id = taskIdRef.current;
      if (!id) throw new Error("Attachments are not available here");
      const name = reserveName(file, kind);
      const mime = file.type || "application/octet-stream";
      dispatch({ type: "begin", name });
      try {
        const bytes = await file.arrayBuffer();
        // 1. Create the pending row; the response carries the presigned PUT.
        const createRes = await client.attachments.$post({
          json: {
            taskId: id,
            filename: name,
            mime,
            size: file.size,
            sha256: await sha256Bytes(bytes),
          },
        });
        if (!createRes.ok) {
          throw new Error(`Failed to create attachment (${createRes.status})`);
        }
        const { attachment, uploadUrl } = await createRes.json();
        // 2. PUT the bytes straight to the bucket. Content-Type must match the
        // signed header; the signed Content-Length rides on the body itself.
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": mime },
          body: bytes,
        });
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
        // 3. Finalize — the server verifies the object and flips the state.
        const finRes = await client.attachments[":id"].finalize.$post({
          param: { id: attachment.id },
        });
        if (!finRes.ok) {
          throw new Error(`Failed to finalize attachment (${finRes.status})`);
        }
        const finalized = await finRes.json();
        // Prime the rows cache synchronously so the ImageNode that's about to
        // resolve this ref finds the row without waiting on the refetch (V1's
        // post-upload race, solved at the source instead of by retries).
        queryClient.setQueryData(
          ["attachments", { taskId: id }],
          (old: unknown) =>
            Array.isArray(old) ? [...old, finalized] : [finalized],
        );
        void queryClient.invalidateQueries({ queryKey: ["attachments"] });
        dispatch({ type: "succeed", name });
        const image = isImageMime(mime);
        return {
          markdown: attachmentMarkdown(name, image),
          relPath: `attachments/${name}`,
          isImage: image,
        };
      } catch (err) {
        dispatch({ type: "fail", name });
        throw err;
      }
    },
    [client, queryClient, reserveName],
  );

  // Editor image upload handler (clipboard paste in the formatted editor).
  // Returns just the relative path, which the editor writes as the image src.
  const imageUploadHandler = useCallback(
    async (file: File): Promise<string> => {
      const up = await uploadOne(file, "pasted-image");
      return up.relPath;
    },
    [uploadOne],
  );

  // Resolve an attachment id → presigned GET URL, through the cache.
  const downloadUrl = useCallback(
    async (attachmentId: string): Promise<string> => {
      const cached = urlCacheRef.current.get(attachmentId);
      if (cached) return cached;
      const inflight = inflightUrlRef.current.get(attachmentId);
      if (inflight) return inflight;
      const fetchUrl = (async () => {
        const response = await client.attachments[":id"].download.$get({
          param: { id: attachmentId },
        });
        if (!response.ok) {
          throw new Error(`Failed to presign download (${response.status})`);
        }
        const { url } = await response.json();
        urlCacheRef.current.put(attachmentId, url);
        return url;
      })();
      inflightUrlRef.current.set(attachmentId, fetchUrl);
      try {
        return await fetchUrl;
      } finally {
        inflightUrlRef.current.delete(attachmentId);
      }
    },
    [client],
  );

  // Editor image preview handler: resolve our stored relative src to a
  // presigned URL for inline display; pass anything else through untouched
  // (absolute URLs, data URIs). An unresolved ref returns the raw src — the
  // ImageNode's retry loop re-resolves while the rows query catches up.
  const imagePreviewHandler = useCallback(
    async (src: string): Promise<string> => {
      const row = resolveAttachmentRef(src, rowsRef.current);
      if (!row) return src;
      return await downloadUrl(row.id);
    },
    [downloadUrl],
  );

  // Open a non-image attachment ref (⌘-click on its body link): resolve to a
  // fresh presigned GET and hand it to window.open — Electron's window-open
  // handler routes that to shell.openExternal, which downloads in the browser
  // (V1's ⌘-click path, with the ref actually resolved). False = not ours.
  const openAttachmentRef = useCallback(
    async (src: string): Promise<boolean> => {
      const row = resolveAttachmentRef(src, rowsRef.current);
      if (!row) return false;
      const url = await downloadUrl(row.id);
      window.open(url, "_blank", "noopener");
      return true;
    },
    [downloadUrl],
  );

  // Row + object delete (best-effort object cleanup server-side). The body ref
  // is the caller's to remove — deleting a row never edits the body.
  const deleteAttachment = useCallback(
    async (attachmentId: string): Promise<void> => {
      const response = await client.attachments[":id"].$delete({
        param: { id: attachmentId },
      });
      if (!response.ok) {
        throw new Error(`Failed to delete attachment (${response.status})`);
      }
      void queryClient.invalidateQueries({ queryKey: ["attachments"] });
    },
    [client, queryClient],
  );

  // Upload a batch and return the markdown snippets to splice into the body.
  // A single failed file is logged and skipped, not fatal (V1's rule).
  const uploadBatch = useCallback(
    async (
      files: File[],
      kindFor: (file: File) => UploadKind,
    ): Promise<string[]> => {
      const ups = await Promise.all(
        files.map((f) =>
          uploadOne(f, kindFor(f)).catch((err) => {
            console.error("Attachment upload failed", err);
            return null;
          }),
        ),
      );
      return ups
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .map((u) => u.markdown);
    },
    [uploadOne],
  );

  // Drop ingress (any file type): dropped files keep their original filename.
  const uploadDropped = useCallback(
    (files: File[]) => uploadBatch(files, () => "dropped"),
    [uploadBatch],
  );

  // Paste ingress (any file type): images get the generated `image-N` name (a
  // pasted screenshot has no meaningful filename), other files keep theirs.
  const uploadPasted = useCallback(
    (files: File[]) =>
      uploadBatch(files, (f) =>
        isImageMime(f.type) ? "pasted-image" : "dropped",
      ),
    [uploadBatch],
  );

  return {
    enabled: taskId !== null,
    uploading: uploadState.uploading,
    failed: uploadState.failed,
    imageUploadHandler,
    imagePreviewHandler,
    openAttachmentRef,
    deleteAttachment,
    uploadDropped,
    uploadPasted,
  };
}

export type AttachmentsV2 = ReturnType<typeof useAttachmentsV2>;
