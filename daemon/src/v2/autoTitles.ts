import { lookup } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";

import type { HitchClient } from "./serverClient.js";
import {
  generateTaskTitle,
  type TaskTitleContext,
} from "./taskTitles.js";

const DEFAULT_TICK_MS = 30_000;
const PAGE_TIMEOUT_MS = 900;
const ATTACHMENT_TIMEOUT_MS = 1_200;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface AutoTitleLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

interface WireTask {
  id: string;
  title: string;
  body: string;
}

interface WireAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

interface ClaimedTitle {
  task: WireTask;
  attachments: WireAttachment[];
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  const v4 = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported URL protocol");
  }
  if (
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443")
  ) {
    throw new Error("unsafe URL authority");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("local URL");
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((row) => isPrivateIp(row.address))) {
    throw new Error("private URL");
  }
}

async function fetchBounded(
  input: string,
  options: { timeoutMs: number; maxBytes: number; publicOnly?: boolean },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let url = new URL(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (options.publicOnly) await assertPublicUrl(url);
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "Hitch/1 task-title-metadata" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect without location");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body) {
        throw new Error(`fetch failed (${response.status})`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > options.maxBytes) throw new Error("response too large");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel();
          throw new Error("response too large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        bytes,
        contentType: response.headers.get("content-type") ?? "",
      };
    }
    throw new Error("too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

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

export function externalUrls(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
      found.add(url.toString());
    } catch {
      // Ignore malformed prose that merely resembles a URL.
    }
  }
  return [...found].slice(0, 2);
}

async function loadPageMetadata(body: string): Promise<TaskTitleContext["linkMetadata"]> {
  const rows = await Promise.all(
    externalUrls(body).map(async (url) => {
      try {
        const response = await fetchBounded(url, {
          timeoutMs: PAGE_TIMEOUT_MS,
          maxBytes: MAX_HTML_BYTES,
          publicOnly: true,
        });
        if (!response.contentType.toLowerCase().includes("text/html")) {
          return { url };
        }
        return {
          url,
          ...pageMetadataFromHtml(new TextDecoder().decode(response.bytes)),
        };
      } catch {
        return { url };
      }
    }),
  );
  return rows;
}

function isReadableText(mime: string): boolean {
  const value = mime.toLowerCase();
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript")
  );
}

function safeExtension(file: WireAttachment): string {
  const ext = extname(file.filename).replace(/[^A-Za-z0-9.]/g, "").slice(0, 12);
  if (ext) return ext;
  if (file.mime === "image/png") return ".png";
  if (file.mime === "image/jpeg") return ".jpg";
  if (file.mime === "image/webp") return ".webp";
  return "";
}

async function attachmentDownloadUrl(
  client: HitchClient,
  attachmentId: string,
): Promise<string> {
  const response = await client.attachments[":id"].download.$get({
    param: { id: attachmentId },
  });
  if (!response.ok) throw new Error(`attachment URL failed (${response.status})`);
  return (await response.json()).url;
}

async function buildContext(options: {
  client: HitchClient;
  claim: ClaimedTitle;
}): Promise<{
  context: TaskTitleContext;
  imagePaths: string[];
  cleanup: () => Promise<void>;
}> {
  const { client, claim } = options;
  const tempDir = await mkdtemp(join(tmpdir(), "hitch-task-title-"));
  const selected = claim.attachments.slice(0, 6);
  const imageIds = new Set(
    selected
      .filter(
        (file) =>
          file.mime.toLowerCase().startsWith("image/") &&
          file.size <= MAX_IMAGE_BYTES,
      )
      .slice(0, 2)
      .map((file) => file.id),
  );
  const linkMetadata = loadPageMetadata(claim.task.body);
  const enriched = await Promise.all(
    selected.map(async (file) => {
      const contextFile: NonNullable<TaskTitleContext["attachments"]>[number] = {
        filename: file.filename,
        mime: file.mime,
        size: file.size,
      };
      let imagePath: string | undefined;
      try {
        if (isReadableText(file.mime) && file.size <= MAX_TEXT_BYTES * 4) {
          const url = await attachmentDownloadUrl(client, file.id);
          const response = await fetchBounded(url, {
            timeoutMs: ATTACHMENT_TIMEOUT_MS,
            maxBytes: MAX_TEXT_BYTES,
          });
          contextFile.text = new TextDecoder().decode(response.bytes);
        } else if (imageIds.has(file.id)) {
          const url = await attachmentDownloadUrl(client, file.id);
          const response = await fetchBounded(url, {
            timeoutMs: ATTACHMENT_TIMEOUT_MS,
            maxBytes: MAX_IMAGE_BYTES,
          });
          imagePath = join(tempDir, `${file.id}${safeExtension(file)}`);
          await writeFile(imagePath, response.bytes);
        }
      } catch {
        // Metadata remains useful; enrichment is strictly best-effort.
        imagePath = undefined;
      }
      return { contextFile, imagePath };
    }),
  );

  return {
    context: {
      body: claim.task.body,
      seedTitle: claim.task.title,
      linkMetadata: await linkMetadata,
      attachments: enriched.map((row) => row.contextFile),
    },
    imagePaths: enriched.flatMap((row) =>
      row.imagePath ? [row.imagePath] : [],
    ),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

export class AutoTitleWorker {
  private running = false;
  private rerun = false;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly options: {
      client: HitchClient;
      machineId: string;
      logger: AutoTitleLogger;
      env?: NodeJS.ProcessEnv;
      tickMs?: number;
    },
  ) {
    this.timer = setInterval(
      () => this.trigger("tick"),
      options.tickMs ?? DEFAULT_TICK_MS,
    );
    this.timer.unref?.();
  }

  start(): void {
    this.trigger("startup");
  }

  trigger(_reason: string): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.runBatch();
      } while (this.rerun && !this.stopped);
    } catch (error) {
      this.options.logger.error?.(`[hitch] auto-title pass failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async runBatch(): Promise<void> {
    const { client, machineId } = this.options;
    const pending = await client.daemon["auto-titles"].$get({
      query: { machine_id: machineId, limit: "5" },
    });
    if (!pending.ok) {
      throw new Error(`auto-title list failed (${pending.status})`);
    }
    const rows = (await pending.json()) as Array<{ id: string }>;
    for (const { id } of rows) {
      if (this.stopped) return;
      await this.runOne(id);
    }
  }

  private async runOne(taskId: string): Promise<void> {
    const { client, machineId, logger } = this.options;
    const claimResponse = await client.daemon["auto-titles"][":id"].claim.$post({
      param: { id: taskId },
      json: { machineId },
    });
    if (claimResponse.status === 409) return;
    if (!claimResponse.ok) {
      throw new Error(`auto-title claim failed (${claimResponse.status})`);
    }
    const claim = (await claimResponse.json()) as ClaimedTitle;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const built = await buildContext({ client, claim });
      cleanup = built.cleanup;
      const generated = await generateTaskTitle({
        context: built.context,
        imagePaths: built.imagePaths,
        env: this.options.env,
      });
      const response = await client.daemon["auto-titles"][":id"].complete.$post({
        param: { id: taskId },
        json: { machineId, title: generated.title },
      });
      if (response.status === 409) {
        logger.info(
          `[hitch] discarded late auto-title for task ${taskId.slice(0, 8)}`,
        );
        return;
      }
      if (!response.ok) {
        throw new Error(`auto-title complete failed (${response.status})`);
      }
      const completion = (await response.json()) as { applied: boolean };
      logger.info(
        completion.applied
          ? `[hitch] auto-titled task ${taskId.slice(0, 8)} → ${generated.title} (${generated.model})`
          : `[hitch] discarded late auto-title for task ${taskId.slice(0, 8)}`,
      );
    } catch (error) {
      const detail = String(error).slice(0, 500);
      await client.daemon["auto-titles"][":id"].fail.$post({
        param: { id: taskId },
        json: { machineId, error: detail || "title generation failed" },
      }).catch(() => undefined);
      logger.error?.(`[hitch] auto-title ${taskId.slice(0, 8)} failed: ${detail}`);
    } finally {
      await cleanup?.().catch(() => {});
    }
  }
}
