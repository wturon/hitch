function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function metaAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

export function pageMetadataFromHtml(html: string): {
  title?: string;
  description?: string;
} {
  let title: string | undefined;
  let description: string | undefined;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = metaAttributes(match[0]);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (!title && (key === "og:title" || key === "twitter:title")) {
      title = decodeHtml(attrs.content ?? "");
    }
    if (
      !description &&
      (key === "og:description" ||
        key === "twitter:description" ||
        key === "description")
    ) {
      description = decodeHtml(attrs.content ?? "");
    }
  }
  if (!title) {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (match) title = decodeHtml(match[1]);
  }
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

export function externalUrls(body: string, limit: number): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
      found.add(url.toString());
    } catch {
      // Ignore malformed prose that merely resembles a URL.
    }
  }
  return [...found].slice(0, limit);
}
