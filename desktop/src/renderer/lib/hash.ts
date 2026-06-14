// sha256 of a string, hex-encoded. Matches the daemon's hashOf() so the `hash`
// field we write from the browser stays consistent with daemon-written rows.
// (The daemon recomputes the content hash on pull, so this is for honesty, not
// correctness — see daemon/src/index.ts.)
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// sha256 of raw bytes, hex-encoded. Matches the daemon's hashOf over a Buffer
// (createHash("sha256").update(buf)), so an attachment row's `hash` lines up
// with what the daemon recomputes on download — letting it skip a re-fetch when
// the local blob already matches.
export async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
