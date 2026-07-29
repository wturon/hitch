import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { externalUrls, pageMetadataFromHtml } from "./pageMetadata.js";
import { fetchPublicBytes, fetchTrustedBytes } from "./safeFetch.js";
import type { HitchClient } from "./serverClient.js";
import { SerialLoop, type DaemonLogger } from "./serialLoop.js";
import {
  generateTaskTitle,
  NoTextGenerationProviderError,
  type TaskTitleContext,
  type TitleAttachment,
} from "./taskTitles.js";

const DEFAULT_TICK_MS = 30_000;
const PAGE_TIMEOUT_MS = 900;
const ATTACHMENT_TIMEOUT_MS = 1_200;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_TEXT_ATTACHMENT_SIZE = MAX_TEXT_BYTES * 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_LINKS = 2;
const MAX_ATTACHMENTS = 6;
const MAX_IMAGES = 2;
const BATCH_SIZE = 5;
const MAX_GENERATION_ATTEMPTS = 3;
const MAX_EXTENSION_LENGTH = 12;

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

interface AutoTitleRequest {
  task: WireTask;
  attachments: WireAttachment[];
}

async function loadPageMetadata(
  body: string,
): Promise<TaskTitleContext["linkMetadata"]> {
  return Promise.all(
    externalUrls(body, MAX_LINKS).map(async (url) => {
      try {
        const response = await fetchPublicBytes(url, {
          timeoutMs: PAGE_TIMEOUT_MS,
          maxBytes: MAX_HTML_BYTES,
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
  const ext = extname(file.filename)
    .replace(/[^A-Za-z0-9.]/g, "")
    .slice(0, MAX_EXTENSION_LENGTH);
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
  if (!response.ok) {
    throw new Error(`attachment URL failed (${response.status})`);
  }
  return (await response.json()).url;
}

async function enrichAttachment(options: {
  client: HitchClient;
  file: WireAttachment;
  imageIds: ReadonlySet<string>;
  tempDir: string;
}): Promise<TitleAttachment> {
  const { client, file, imageIds, tempDir } = options;
  const base: TitleAttachment = {
    filename: file.filename,
    mime: file.mime,
    size: file.size,
  };
  try {
    if (isReadableText(file.mime) && file.size <= MAX_TEXT_ATTACHMENT_SIZE) {
      const url = await attachmentDownloadUrl(client, file.id);
      const response = await fetchTrustedBytes(url, {
        timeoutMs: ATTACHMENT_TIMEOUT_MS,
        maxBytes: MAX_TEXT_BYTES,
      });
      return { ...base, text: new TextDecoder().decode(response.bytes) };
    }
    if (imageIds.has(file.id)) {
      const url = await attachmentDownloadUrl(client, file.id);
      const response = await fetchTrustedBytes(url, {
        timeoutMs: ATTACHMENT_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
      });
      const imagePath = join(tempDir, `${file.id}${safeExtension(file)}`);
      await writeFile(imagePath, response.bytes);
      return { ...base, imagePath };
    }
  } catch {
    // Filename/mime/size remain useful; enrichment is strictly best-effort.
  }
  return base;
}

async function buildContext(options: {
  client: HitchClient;
  request: AutoTitleRequest;
}): Promise<{ context: TaskTitleContext; tempDir: string }> {
  const { client, request } = options;
  const tempDir = await mkdtemp(join(tmpdir(), "hitch-task-title-"));
  const selected = request.attachments.slice(0, MAX_ATTACHMENTS);
  const imageIds = new Set(
    selected
      .filter(
        (file) =>
          file.mime.toLowerCase().startsWith("image/") &&
          file.size <= MAX_IMAGE_BYTES,
      )
      .slice(0, MAX_IMAGES)
      .map((file) => file.id),
  );
  const [linkMetadata, attachments] = await Promise.all([
    loadPageMetadata(request.task.body),
    Promise.all(
      selected.map((file) =>
        enrichAttachment({ client, file, imageIds, tempDir }),
      ),
    ),
  ]);
  return {
    context: {
      body: request.task.body,
      seedTitle: request.task.title,
      linkMetadata,
      attachments,
    },
    tempDir,
  };
}

export class AutoTitleWorker {
  private readonly loop: SerialLoop;
  private readonly attemptsByTask = new Map<string, number>();

  constructor(
    private readonly options: {
      client: HitchClient;
      machineId: string;
      logger: DaemonLogger;
      env?: NodeJS.ProcessEnv;
      tickMs?: number;
      generateTitle?: typeof generateTaskTitle;
    },
  ) {
    this.loop = new SerialLoop({
      intervalMs: options.tickMs ?? DEFAULT_TICK_MS,
      pass: () => this.runBatch(),
      onError: (error) => {
        this.options.logger.error?.(
          `[hitch] auto-title pass failed: ${String(error)}`,
        );
      },
    });
  }

  start(): void {
    this.loop.start();
  }

  trigger(reason: string): void {
    this.loop.trigger(reason);
  }

  stop(): void {
    this.loop.stop();
  }

  private async runBatch(): Promise<void> {
    const { client, machineId } = this.options;
    const response = await client.daemon["auto-titles"].$get({
      query: {
        requesting_machine_id: machineId,
        limit: String(BATCH_SIZE),
      },
    });
    if (!response.ok) {
      throw new Error(`auto-title list failed (${response.status})`);
    }
    const requests = (await response.json()) as AutoTitleRequest[];
    for (const request of requests) {
      if (this.loop.isStopped) return;
      await this.runOne(request);
    }
  }

  private async runOne(request: AutoTitleRequest): Promise<void> {
    const { client, machineId, logger } = this.options;
    let tempDir: string | undefined;
    try {
      const built = await buildContext({ client, request });
      tempDir = built.tempDir;
      const generated = await (this.options.generateTitle ?? generateTaskTitle)({
        context: built.context,
        env: this.options.env,
      });
      const response = await client.daemon["auto-titles"][":id"].complete.$post({
        param: { id: request.task.id },
        json: { machineId, title: generated.title },
      });
      if (response.status === 409) {
        this.attemptsByTask.delete(request.task.id);
        logger.info(
          `[hitch] discarded late auto-title for task ${request.task.id.slice(0, 8)}`,
        );
        return;
      }
      if (!response.ok) {
        throw new Error(`auto-title complete failed (${response.status})`);
      }
      this.attemptsByTask.delete(request.task.id);
      logger.info(
        `[hitch] auto-titled task ${request.task.id.slice(0, 8)} → ${generated.title} (${generated.model})`,
      );
    } catch (error) {
      const attempts = (this.attemptsByTask.get(request.task.id) ?? 0) + 1;
      const permanent = error instanceof NoTextGenerationProviderError;
      const exhausted = attempts >= MAX_GENERATION_ATTEMPTS;
      if (permanent || exhausted) {
        this.attemptsByTask.delete(request.task.id);
        // Clear atomically after a permanent failure or the bounded retry
        // budget. A concurrent user edit still wins the server-side CAS.
        await client.daemon["auto-titles"][":id"].complete
          .$post({
            param: { id: request.task.id },
            json: { machineId, title: null },
          })
          .catch(() => undefined);
      } else {
        this.attemptsByTask.set(request.task.id, attempts);
      }
      logger.error?.(
        `[hitch] auto-title ${request.task.id.slice(0, 8)} failed` +
          (permanent
            ? " permanently"
            : exhausted
              ? ` after ${attempts} attempts`
              : `; retry ${attempts + 1}/${MAX_GENERATION_ATTEMPTS} next tick`) +
          `: ${String(error)}`,
      );
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
