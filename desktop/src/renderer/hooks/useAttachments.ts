"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256Bytes } from "@/lib/hash";

// What the upload path needs: which project owns the blobs and which doc folder
// they belong to. `base` is the primitive's root folder under .hitch/ ("tasks"
// by default; "notes" for notes), so the same hook serves both — the on-disk
// attachment key is `<base>/<slug>/attachments/<file>`. When the context is
// undefined (a non-doc use), the hook stays inert and `enabled` is false, so
// callers can omit the editor's image/drop wiring.
export interface AttachmentContext {
  projectId: Id<"projects">;
  slug: string;
  base?: string;
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

// Extension for a pasted/clipboard image, which carries no filename: derive it
// from the MIME type (image/png → png, image/jpeg → jpg, image/svg+xml → svg).
function extForImage(file: File): string {
  const sub = (file.type.split("/")[1] || "png").toLowerCase();
  const base = sub.split("+")[0];
  return base === "jpeg" ? "jpg" : base || "png";
}

// A safe, readable on-disk name from a dropped file's name: kebab the base
// (matching the app's slug convention) and keep a clean extension. Agents read
// these paths, so `Quarterly Report.pdf` → `quarterly-report.pdf` beats a hash.
function sanitizeName(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const justName = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = justName.lastIndexOf(".");
  const rawBase = dot > 0 ? justName.slice(0, dot) : justName;
  const rawExt = dot > 0 ? justName.slice(dot + 1) : "";
  const base =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "file";
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return ext ? `${base}.${ext}` : base;
}

// Insert a `-N` before the extension to dodge a name collision.
function withSuffix(name: string, k: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${k}${name.slice(dot)}` : `${name}-${k}`;
}

// The kind of ingress, which only affects naming: a pasted image has no useful
// filename so it gets the generated `image-N.ext`; a dropped file keeps its own.
type UploadKind = "pasted-image" | "dropped";

export interface AttachmentUpload {
  // The standard-markdown snippet to insert: `![](attachments/x.png)` for an
  // image (renders inline) or `[name](attachments/x.pdf)` for any other file.
  markdown: string;
  relPath: string;
  isImage: boolean;
}

// The single ingress for task attachments. Both the editor's image paste
// (imageUploadHandler) and the dialog-level file drop share this hook so they
// use one in-flight counter, one name-reservation set, and one attachments
// query — avoiding collisions when a paste and a drop race. The renderer is the
// sole upload path; the daemon is download-only.
export function useAttachments(ctx: AttachmentContext | undefined) {
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl);
  const registerAttachment = useMutation(api.attachments.registerAttachment);
  const rows = useQuery(
    api.attachments.listAttachments,
    ctx ? { projectId: ctx.projectId } : "skip",
  );

  // Mirror the moving parts into refs so the returned callbacks stay stable
  // (the editor's image plugin reads its handlers once) while still seeing the
  // latest context / attachment list.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Names handed out this session but not yet visible in `rows` (the query lags
  // a registration), so concurrent uploads — incl. a multi-file drop — can't
  // pick the same name.
  const reservedRef = useRef<Set<string>>(new Set());
  const [uploading, setUploading] = useState(0);

  // Pick a unique filename within the task's attachments folder, reserving it.
  const reserveName = useCallback((file: File, kind: UploadKind): string => {
    const c = ctxRef.current;
    if (!c) throw new Error("Attachments are not available here");
    const prefix = `${c.base ?? "tasks"}/${c.slug}/attachments/`;
    const taken = new Set<string>(reservedRef.current);
    for (const row of rowsRef.current ?? []) {
      if (!row.deleted && row.path.startsWith(prefix)) {
        taken.add(row.path.slice(prefix.length));
      }
    }

    let name: string;
    if (kind === "pasted-image" || !file.name) {
      let maxN = 0;
      for (const t of taken) {
        const m = t.match(/^image-(\d+)\./);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
      name = `image-${maxN + 1}.${extForImage(file)}`;
    } else {
      name = sanitizeName(file.name);
    }
    if (taken.has(name)) {
      let k = 2;
      while (taken.has(withSuffix(name, k))) k++;
      name = withSuffix(name, k);
    }
    reservedRef.current.add(name);
    return name;
  }, []);

  const uploadOne = useCallback(
    async (file: File, kind: UploadKind): Promise<AttachmentUpload> => {
      const c = ctxRef.current;
      if (!c) throw new Error("Attachments are not available here");
      const name = reserveName(file, kind);
      const relPath = `attachments/${name}`; // markdown src (rel to the doc body)
      const rowPath = `${c.base ?? "tasks"}/${c.slug}/${relPath}`; // key (rel to .hitch)

      setUploading((n) => n + 1);
      try {
        const uploadUrl = await generateUploadUrl({ projectId: c.projectId });
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const { storageId } = (await res.json()) as { storageId: string };
        const bytes = await file.arrayBuffer();
        // Register BEFORE returning, so the reference only enters the body once a
        // backing row exists; a failure leaves no dangling link.
        await registerAttachment({
          projectId: c.projectId,
          path: rowPath,
          storageId: storageId as Id<"_storage">,
          hash: await sha256Bytes(bytes),
          contentType: file.type || "application/octet-stream",
          size: file.size,
        });
        const image = isImage(file);
        return {
          markdown: image ? `![](${relPath})` : `[${name}](${relPath})`,
          relPath,
          isImage: image,
        };
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [generateUploadUrl, registerAttachment, reserveName],
  );

  // MDXEditor image-plugin upload handler (clipboard paste). Returns just the
  // relative path, which the plugin writes as the image `src`.
  const imageUploadHandler = useCallback(
    async (file: File): Promise<string> => {
      const up = await uploadOne(file, "pasted-image");
      return up.relPath;
    },
    [uploadOne],
  );

  // MDXEditor image-plugin preview handler: resolve our stored relative `src`
  // to a signed Convex URL for inline display; pass anything else through.
  const imagePreviewHandler = useCallback(async (src: string): Promise<string> => {
    const c = ctxRef.current;
    if (!c || !src.startsWith("attachments/")) return src;
    const rowPath = `${c.base ?? "tasks"}/${c.slug}/${src}`;
    const match = (rowsRef.current ?? []).find(
      (row) => !row.deleted && row.path === rowPath,
    );
    return match?.url ?? src;
  }, []);

  // Upload a batch and return the markdown snippets to splice into the body. A
  // single failed file is logged and skipped, not fatal. `kindFor` picks the
  // naming convention per file: drops keep their filename; pasted images (no
  // useful name) get the generated `image-N`.
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
        .filter((u): u is AttachmentUpload => u !== null)
        .map((u) => u.markdown);
    },
    [uploadOne],
  );

  // Drop ingress (any file type): dropped files keep their original filename.
  const uploadDropped = useCallback(
    (files: File[]) => uploadBatch(files, () => "dropped"),
    [uploadBatch],
  );

  // Paste ingress (any file type): images use the generated `image-N` name (a
  // pasted screenshot has no meaningful filename), other files keep theirs.
  const uploadPasted = useCallback(
    (files: File[]) =>
      uploadBatch(files, (f) => (isImage(f) ? "pasted-image" : "dropped")),
    [uploadBatch],
  );

  return {
    enabled: Boolean(ctx),
    uploading,
    imageUploadHandler,
    imagePreviewHandler,
    uploadDropped,
    uploadPasted,
  };
}
