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
