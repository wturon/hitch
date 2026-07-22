// Human-output helpers. Pure — unit-tested in __tests__.

/** Truncate to `max` chars with a trailing ellipsis; newlines collapse. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * Render rows as a plain aligned table (two-space gutters, lowercase-free
 * UPPER headers, no borders). Every cell is taken as-is — truncate first.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/** ISO timestamp → "2026-07-22 14:03" in local time (listing-friendly). */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Stable machine output: one JSON document, 2-space indent, trailing newline. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
