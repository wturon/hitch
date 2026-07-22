import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Blob storage (see docs/v2-prd.md "Blobs"): S3-agnostic on purpose — Railway
// Buckets in prod, Garage in the self-host compose, R2 as env-var-swap
// fallback. The DB stores object KEYS only, never URLs; clients get short-lived
// presigned URLs from the /attachments routes. Injected like db (see createApp)
// so tests can point the app at a throwaway Garage container.

export type StorageConfig = {
  /** S3 API endpoint the SERVER talks to (HEAD/DELETE at finalize/delete). */
  endpoint: string;
  /**
   * Endpoint baked into presigned URLs (what CLIENTS can reach). Defaults to
   * `endpoint`; differs in docker-compose, where the server reaches Garage at
   * http://storage:3900 but browsers/Electron only see http://localhost:3900.
   * The signature binds the host, so these must be configured, not rewritten.
   */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing — required for Garage/MinIO-style endpoints. */
  forcePathStyle: boolean;
  /** Enforced at finalize-time — presigned URLs can't enforce a cap (PRD). */
  maxUploadBytes: number;
};

export type Storage = {
  maxUploadBytes: number;
  /** Presigned PUT, content-type + content-length bound, 15 min expiry. */
  presignUpload(key: string, mime: string, size: number): Promise<string>;
  /** Presigned GET, 5 min expiry. */
  presignDownload(key: string): Promise<string>;
  /** Actual object size in bytes, or undefined when the object doesn't exist. */
  headSize(key: string): Promise<number | undefined>;
  /** Throws on failure — callers decide whether a failed delete is fatal. */
  deleteObject(key: string): Promise<void>;
};

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

// Defaults match the docker-compose Garage service (see docker-compose.yml) so
// `npm run dev` against a composed stack needs zero S3 config. Prod (Railway)
// MUST override all of these — see .env.example.
const DEV_DEFAULTS = {
  endpoint: "http://localhost:3900",
  region: "garage",
  bucket: "hitch",
  accessKeyId: "GKa1b2c3d4e5f60718293a4b5c",
  secretAccessKey: "7d4f9a2b1c8e5f30d6a4b2c19e7f5d3a8b6c4e2f0a9d7b5c3e1f8a6d4b2c0e9f",
} as const;

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT ?? DEV_DEFAULTS.endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    region: env.S3_REGION ?? DEV_DEFAULTS.region,
    bucket: env.S3_BUCKET ?? DEV_DEFAULTS.bucket,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? DEV_DEFAULTS.accessKeyId,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? DEV_DEFAULTS.secretAccessKey,
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
    maxUploadBytes: env.S3_MAX_UPLOAD_BYTES
      ? Number(env.S3_MAX_UPLOAD_BYTES)
      : DEFAULT_MAX_UPLOAD_BYTES,
  };
}

export function createStorage(config: StorageConfig): Storage {
  const clientFor = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
      // The SDK's default flexible checksums (CRC32) break third-party S3
      // implementations: Garage rejects the presigned PUT with InvalidDigest.
      // WHEN_REQUIRED restores plain SigV4 behavior.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

  // Two clients because presigned URLs bind the host into the signature: the
  // ops client uses the server-reachable endpoint, the presign client the
  // client-reachable one (identical unless publicEndpoint is set).
  const opsClient = clientFor(config.endpoint);
  const presignClient = config.publicEndpoint
    ? clientFor(config.publicEndpoint)
    : opsClient;

  return {
    maxUploadBytes: config.maxUploadBytes,

    presignUpload(key, mime, size) {
      // ContentLength lands in X-Amz-SignedHeaders, so a PUT with a different
      // byte count fails the signature — but that's S3-implementation-defined,
      // which is why finalize re-checks the real size (PRD: caps enforced at
      // finalize-time).
      return getSignedUrl(
        presignClient,
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ContentType: mime,
          ContentLength: size,
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
    },

    presignDownload(key) {
      return getSignedUrl(
        presignClient,
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
    },

    async headSize(key) {
      try {
        const head = await opsClient.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return head.ContentLength;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if ((error as Error).name === "NotFound" || status === 404) return undefined;
        throw error;
      }
    },

    async deleteObject(key) {
      await opsClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
