// Convex mutation errors arrive wrapped in transport noise
// ("[CONVEX M(snippets:create)] [Request ID: …] Server Error\nUncaught Error:
// <message>\n  at …"). Pull out the user-facing message the mutation threw.
export function mutationErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const marker = "Uncaught Error: ";
  const start = raw.indexOf(marker);
  if (start === -1) return raw;
  const rest = raw.slice(start + marker.length);
  const end = rest.indexOf("\n");
  return (end === -1 ? rest : rest.slice(0, end)).trim() || raw;
}
