// Pure attachment logic (M2 PR 6): naming (V1's conventions, verbatim), the
// relative-ref markdown, ref→row resolution (against the ROW filename, never
// the S3 key), the presigned-URL cache's expiry margin, and the upload state
// machine.
import { describe, expect, it } from "vitest";

import {
  attachmentMarkdown,
  createUrlCache,
  DOWNLOAD_URL_TTL_MS,
  extForImageMime,
  hrefToAttachmentRef,
  initialUploadState,
  pickAttachmentName,
  refFilename,
  resolveAttachmentRef,
  sanitizeName,
  uploadReducer,
  URL_CACHE_MARGIN_MS,
  withSuffix,
  type UploadState,
} from "../attachmentModel";

describe("naming (V1 conventions)", () => {
  it("derives the pasted-image extension from the MIME type", () => {
    expect(extForImageMime("image/png")).toBe("png");
    expect(extForImageMime("image/jpeg")).toBe("jpg");
    expect(extForImageMime("image/svg+xml")).toBe("svg");
    expect(extForImageMime("")).toBe("png");
  });

  it("kebab-sanitizes a dropped file's name, keeping a clean extension", () => {
    expect(sanitizeName("Quarterly Report.pdf")).toBe("quarterly-report.pdf");
    expect(sanitizeName("weird//path\\Name File.TXT")).toBe("name-file.txt");
    expect(sanitizeName("...")).toBe("file");
  });

  it("suffixes before the extension on collision", () => {
    expect(withSuffix("shot.png", 2)).toBe("shot-2.png");
    expect(withSuffix("noext", 3)).toBe("noext-3");
  });

  it("names pasted images image-N past the highest taken N", () => {
    const taken = new Set(["image-1.png", "image-3.jpg", "unrelated.png"]);
    expect(
      pickAttachmentName("pasted-image", { name: "clipboard.png", type: "image/png" }, taken),
    ).toBe("image-4.png");
  });

  it("keeps a dropped file's (sanitized) name and dodges collisions", () => {
    const taken = new Set(["report.pdf", "report-2.pdf"]);
    expect(
      pickAttachmentName("dropped", { name: "Report.pdf", type: "application/pdf" }, taken),
    ).toBe("report-3.pdf");
  });

  it("treats a dropped file with no name as a pasted image", () => {
    expect(
      pickAttachmentName("dropped", { name: "", type: "image/png" }, new Set()),
    ).toBe("image-1.png");
  });
});

describe("attachmentMarkdown", () => {
  it("emits an inline image for images and a plain link otherwise — always the relative ref", () => {
    expect(attachmentMarkdown("shot.png", true)).toBe("![](attachments/shot.png)");
    expect(attachmentMarkdown("report.pdf", false)).toBe(
      "[report.pdf](attachments/report.pdf)",
    );
  });
});

describe("ref resolution", () => {
  const rows = [
    {
      id: "a1",
      // The row keeps the VERBATIM client-declared filename; the server's KEY
      // sanitizer would have turned this into `quarterly_report.pdf` inside
      // `attachments/<uuid>/…`. Resolution must never look at the key.
      filename: "quarterly-report.pdf",
      state: "finalized",
    },
    { id: "a2", filename: "image-1.png", state: "finalized" },
    { id: "a3", filename: "pending.png", state: "pending" },
  ];

  it("extracts the filename from our refs only", () => {
    expect(refFilename("attachments/shot.png")).toBe("shot.png");
    expect(refFilename("https://example.com/attachments/shot.png")).toBeNull();
    expect(refFilename("attachments/")).toBeNull();
    // A nested path is never one of ours (we only ever emit one segment).
    expect(refFilename("attachments/uuid/shot.png")).toBeNull();
    expect(refFilename("other/shot.png")).toBeNull();
  });

  it("resolves against the ROW filename, sanitization mismatch and all", () => {
    expect(resolveAttachmentRef("attachments/quarterly-report.pdf", rows)?.id).toBe("a1");
    expect(resolveAttachmentRef("attachments/image-1.png", rows)?.id).toBe("a2");
    // The server-side KEY spelling of the same file must NOT resolve.
    expect(resolveAttachmentRef("attachments/quarterly_report.pdf", rows)).toBeUndefined();
  });

  it("never resolves a pending row (its bytes may not exist; /download 400s)", () => {
    expect(resolveAttachmentRef("attachments/pending.png", rows)).toBeUndefined();
  });

  it("normalizes the DOM-anchor form of our refs (Lexical prepends https://)", () => {
    // The model href is `attachments/<name>`, but LinkNode's formatUrl renders
    // the DOM anchor as `https://attachments/<name>` — both are ours.
    expect(hrefToAttachmentRef("attachments/report.pdf")).toBe("attachments/report.pdf");
    expect(hrefToAttachmentRef("https://attachments/report.pdf")).toBe(
      "attachments/report.pdf",
    );
    // Real URLs (host with a dot, deeper paths) and other refs are not ours.
    expect(hrefToAttachmentRef("https://example.com/attachments/report.pdf")).toBeNull();
    expect(hrefToAttachmentRef("https://attachments/nested/report.pdf")).toBeNull();
    expect(hrefToAttachmentRef("http://attachments/report.pdf")).toBeNull();
    expect(hrefToAttachmentRef("other/report.pdf")).toBeNull();
    expect(hrefToAttachmentRef("")).toBeNull();
  });

  it("passes through when rows are absent or the src is not ours", () => {
    expect(resolveAttachmentRef("attachments/image-1.png", undefined)).toBeUndefined();
    expect(resolveAttachmentRef("https://x.test/a.png", rows)).toBeUndefined();
  });
});

describe("url cache expiry", () => {
  it("serves a fresh URL and expires it a margin BEFORE the presign lapses", () => {
    let now = 1_000_000;
    const cache = createUrlCache(() => now);
    expect(cache.get("a1")).toBeNull();
    cache.put("a1", "https://signed/a1");
    expect(cache.get("a1")).toBe("https://signed/a1");

    // Just inside the fresh window (~4 of the 5 minutes): still served.
    now += DOWNLOAD_URL_TTL_MS - URL_CACHE_MARGIN_MS - 1;
    expect(cache.get("a1")).toBe("https://signed/a1");

    // At the margin boundary: treated as stale, forcing a re-mint well before
    // the URL actually 403s mid-load.
    now += 1;
    expect(cache.get("a1")).toBeNull();
  });

  it("a re-put after expiry restarts the window", () => {
    let now = 0;
    const cache = createUrlCache(() => now);
    cache.put("a1", "https://signed/v1");
    now += DOWNLOAD_URL_TTL_MS; // long past fresh
    expect(cache.get("a1")).toBeNull();
    cache.put("a1", "https://signed/v2");
    expect(cache.get("a1")).toBe("https://signed/v2");
  });
});

describe("upload state machine", () => {
  it("counts concurrent uploads and settles back to idle", () => {
    let s: UploadState = initialUploadState;
    s = uploadReducer(s, { type: "begin", name: "a.png" });
    s = uploadReducer(s, { type: "begin", name: "b.pdf" });
    expect(s.uploading).toBe(2);
    s = uploadReducer(s, { type: "succeed", name: "a.png" });
    s = uploadReducer(s, { type: "succeed", name: "b.pdf" });
    expect(s).toEqual({ uploading: 0, failed: [] });
  });

  it("records a failure once, and a retry's begin clears it", () => {
    let s: UploadState = initialUploadState;
    s = uploadReducer(s, { type: "begin", name: "a.png" });
    s = uploadReducer(s, { type: "fail", name: "a.png" });
    expect(s).toEqual({ uploading: 0, failed: ["a.png"] });
    // A second failure for the same name doesn't duplicate.
    s = uploadReducer(s, { type: "begin", name: "a.png" });
    s = uploadReducer(s, { type: "fail", name: "a.png" });
    expect(s.failed).toEqual(["a.png"]);
    // Retry: begin clears the failure; success leaves a clean slate.
    s = uploadReducer(s, { type: "begin", name: "a.png" });
    expect(s).toEqual({ uploading: 1, failed: [] });
    s = uploadReducer(s, { type: "succeed", name: "a.png" });
    expect(s).toEqual({ uploading: 0, failed: [] });
  });

  it("never drives the uploading count negative", () => {
    const s = uploadReducer(initialUploadState, { type: "succeed", name: "x" });
    expect(s.uploading).toBe(0);
  });
});
