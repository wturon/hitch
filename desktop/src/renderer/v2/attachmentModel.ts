// Pure attachment logic for the V2 dialog (M2 PR 6): naming, the markdown the
// body carries, ref→row resolution, the presigned-URL cache, and the upload
// state machine. Everything here is side-effect free so the whole layer is
// unit-testable; useAttachmentsV2 wires it to the hc client.
//
// Conventions are V1's, verbatim (hooks/useAttachments.ts is the reference):
//   • a pasted image (no useful filename) is named `image-N.<ext>`;
//   • a dropped file keeps its own name, kebab-sanitized
//     (`Quarterly Report.pdf` → `quarterly-report.pdf`);
//   • collisions get a `-N` before the extension;
//   • the BODY keeps a relative ref — `![](attachments/x.png)` for images,
//     `[x.pdf](attachments/x.pdf)` for anything else. NEVER a presigned URL
//     (they expire; PRD: keys in the DB, URLs minted on demand).
//
// Resolution invariant: a body ref `attachments/<name>` resolves against the
// attachment ROW's `filename` column — the verbatim name the client declared —
// never against the S3 `key`. The server sanitizes the key its own way
// (attachments/<uuid>/<server-sanitized-name>), so parsing the key would break
// on any filename the two sanitizers disagree about.

export type UploadKind = "pasted-image" | "dropped";

// The row fields resolution needs (a projection of the server's attachments
// row — shared/'s Attachment type carries more).
export interface AttachmentRefRow {
  id: string;
  filename: string;
  state: string;
}

export const ATTACHMENT_REF_PREFIX = "attachments/";

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

// Extension for a pasted/clipboard image, which carries no filename: derive it
// from the MIME type (image/png → png, image/jpeg → jpg, image/svg+xml → svg).
// V1's extForImage, over the mime string.
export function extForImageMime(mime: string): string {
  const sub = (mime.split("/")[1] || "png").toLowerCase();
  const base = sub.split("+")[0];
  return base === "jpeg" ? "jpg" : base || "png";
}

// A safe, readable name from a dropped file's name: kebab the base (matching
// the app's slug convention) and keep a clean extension. V1's sanitizeName,
// verbatim — agents read these refs, so `quarterly-report.pdf` beats a hash.
export function sanitizeName(name: string): string {
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

// Insert a `-N` before the extension to dodge a name collision (V1 verbatim).
export function withSuffix(name: string, k: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${k}${name.slice(dot)}` : `${name}-${k}`;
}

// Pick a unique filename within the task's attachment set — the pure core of
// V1's reserveName. `taken` is every name already in use (existing rows plus
// this session's in-flight reservations).
export function pickAttachmentName(
  kind: UploadKind,
  file: { name: string; type: string },
  taken: ReadonlySet<string>,
): string {
  let name: string;
  if (kind === "pasted-image" || !file.name) {
    let maxN = 0;
    for (const t of taken) {
      const m = t.match(/^image-(\d+)\./);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    name = `image-${maxN + 1}.${extForImageMime(file.type)}`;
  } else {
    name = sanitizeName(file.name);
  }
  if (taken.has(name)) {
    let k = 2;
    while (taken.has(withSuffix(name, k))) k++;
    name = withSuffix(name, k);
  }
  return name;
}

// The standard-markdown snippet the body carries: inline image or plain link,
// always the RELATIVE ref (V1's convention, byte-identical).
export function attachmentMarkdown(name: string, image: boolean): string {
  const relPath = `${ATTACHMENT_REF_PREFIX}${name}`;
  return image ? `![](${relPath})` : `[${name}](${relPath})`;
}

// A DOM anchor's href → our relative ref, or null. The MODEL always carries
// the raw `attachments/<name>` (round-trips to markdown verbatim), but
// Lexical's LinkNode runs the href through its formatUrl when rendering the
// DOM, which prepends `https://` to any protocol-less non-path href — so the
// anchor the click listener sees is `https://attachments/<name>`. Both forms
// normalize here; the fake "attachments" host is not a resolvable name, so a
// real external URL can't collide.
export function hrefToAttachmentRef(href: string): string | null {
  const raw = href.startsWith(`https://${ATTACHMENT_REF_PREFIX}`)
    ? href.slice("https://".length)
    : href;
  return refFilename(raw) !== null ? raw : null;
}

// `attachments/<name>` → `<name>`; null for anything that isn't ours (absolute
// URLs, data URIs, other relative paths pass through untouched upstream).
export function refFilename(src: string): string | null {
  if (!src.startsWith(ATTACHMENT_REF_PREFIX)) return null;
  const name = src.slice(ATTACHMENT_REF_PREFIX.length);
  // A nested path is not one of our refs (we never generate them).
  if (name === "" || name.includes("/")) return null;
  return name;
}

// Resolve a body ref to its attachment row — by the ROW's verbatim filename
// (see header). Only a finalized row resolves: pending means the bytes may not
// exist yet, and /download 400s on it anyway.
export function resolveAttachmentRef(
  src: string,
  rows: ReadonlyArray<AttachmentRefRow> | undefined,
): AttachmentRefRow | undefined {
  const name = refFilename(src);
  if (name === null || !rows) return undefined;
  return rows.find((row) => row.filename === name && row.state === "finalized");
}

// ─── Presigned-URL cache ─────────────────────────────────────────────────────
// Download URLs are presigned for 5 minutes (server storage.ts). Serving one
// that's about to lapse hands an <img> a URL that 403s mid-load, so entries
// are considered fresh only up to TTL − margin (~4 minutes of the 5).

export const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;
export const URL_CACHE_MARGIN_MS = 60 * 1000;

export interface UrlCache {
  /** The cached URL, or null when absent/too close to expiry. */
  get(id: string): string | null;
  put(id: string, url: string): void;
}

export function createUrlCache(
  now: () => number = () => Date.now(),
  ttlMs: number = DOWNLOAD_URL_TTL_MS,
  marginMs: number = URL_CACHE_MARGIN_MS,
): UrlCache {
  const entries = new Map<string, { url: string; freshUntil: number }>();
  return {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (now() >= entry.freshUntil) {
        entries.delete(id);
        return null;
      }
      return entry.url;
    },
    put(id, url) {
      entries.set(id, { url, freshUntil: now() + ttlMs - marginMs });
    },
  };
}

// ─── Upload state machine ────────────────────────────────────────────────────
// What the UI can observe about in-flight uploads: how many are running and
// which names failed. begin() clears a name from `failed` (a retry supersedes
// the failure); fail() records it once.

export interface UploadState {
  uploading: number;
  failed: readonly string[];
}

export const initialUploadState: UploadState = { uploading: 0, failed: [] };

export type UploadEvent =
  | { type: "begin"; name: string }
  | { type: "succeed"; name: string }
  | { type: "fail"; name: string };

export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case "begin":
      return {
        uploading: state.uploading + 1,
        failed: state.failed.filter((name) => name !== event.name),
      };
    case "succeed":
      return { ...state, uploading: Math.max(0, state.uploading - 1) };
    case "fail":
      return {
        uploading: Math.max(0, state.uploading - 1),
        failed: state.failed.includes(event.name)
          ? state.failed
          : [...state.failed, event.name],
      };
  }
}
