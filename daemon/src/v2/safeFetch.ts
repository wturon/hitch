import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export interface BoundedResponse {
  bytes: Uint8Array;
  contentType: string;
}

interface ByteReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
}

async function readBounded(
  reader: ByteReader,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
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
  return bytes;
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("::") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
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

async function pinnedPublicAddress(url: URL): Promise<{
  address: string;
  family: number;
  hostname: string;
}> {
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
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("local URL");
  }
  const addresses = await lookup(hostname, { all: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => privateAddress(address))
  ) {
    throw new Error("private URL");
  }
  return { ...addresses[0], hostname };
}

async function collectResponse(
  response: IncomingMessage,
  maxBytes: number,
): Promise<BoundedResponse & { status: number; location?: string }> {
  const declared = Number(response.headers["content-length"] ?? "0");
  if (declared > maxBytes) {
    response.destroy();
    throw new Error("response too large");
  }
  const iterator = response[Symbol.asyncIterator]();
  const bytes = await readBounded(
    {
      read: async () => {
        const next = await iterator.next();
        return {
          done: next.done ?? false,
          ...(next.value
            ? { value: new Uint8Array(next.value as Uint8Array) }
            : {}),
        };
      },
      cancel: async () => {
        response.destroy();
      },
    },
    maxBytes,
  );
  const contentType = response.headers["content-type"];
  const location = response.headers.location;
  return {
    bytes,
    contentType: Array.isArray(contentType)
      ? (contentType[0] ?? "")
      : (contentType ?? ""),
    status: response.statusCode ?? 0,
    ...(typeof location === "string" ? { location } : {}),
  };
}

async function requestPinned(
  url: URL,
  signal: AbortSignal,
  maxBytes: number,
): Promise<BoundedResponse & { status: number; location?: string }> {
  const { address, family, hostname } = await pinnedPublicAddress(url);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address,
        family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          host: url.host,
          "user-agent": "Hitch/1 task-title-metadata",
        },
        signal,
        ...(url.protocol === "https:" && isIP(hostname) === 0
          ? { servername: hostname }
          : {}),
      },
      (response) => {
        void collectResponse(response, maxBytes).then(resolve, reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Resolves and validates every redirect target, then connects to that exact IP.
// The Host header and TLS servername retain normal virtual-host/certificate
// behavior without a second DNS lookup.
export async function fetchPublicBytes(
  input: string,
  options: { timeoutMs: number; maxBytes: number },
): Promise<BoundedResponse> {
  const controller = new AbortController();
  let url = new URL(input);
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  // AbortSignal bounds the socket request, while this explicit race also
  // bounds dns.lookup, which does not accept that signal.
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error("fetch timed out"));
  }, options.timeoutMs);
  try {
    const fetchRedirects = async () => {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await requestPinned(
          url,
          controller.signal,
          options.maxBytes,
        );
        if (response.status >= 300 && response.status < 400) {
          if (!response.location) throw new Error("redirect without location");
          url = new URL(response.location, url);
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`fetch failed (${response.status})`);
        }
        return response;
      }
      throw new Error("too many redirects");
    };
    return await Promise.race([fetchRedirects(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Attachment URLs are short-lived presigned URLs minted by Hitch's own server,
// not user-authored destinations. They still get strict time and byte bounds.
export async function fetchTrustedBytes(
  input: string,
  options: { timeoutMs: number; maxBytes: number },
): Promise<BoundedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(input, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`fetch failed (${response.status})`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > options.maxBytes) throw new Error("response too large");
    const reader = response.body.getReader();
    const bytes = await readBounded(
      {
        read: () => reader.read(),
        cancel: () => reader.cancel(),
      },
      options.maxBytes,
    );
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}
