// Replace the LOCAL docker-compose Postgres with a copy of the Railway PROD
// database. One-directional by construction: this script only ever READS from
// prod and only ever WRITES to local. See the safety rails below.
//
// Run:   node scripts/sync-local-from-prod.mjs [--yes] [--with-objects]
//   or:  npm run db:sync-from-prod -- --yes
//
// Requires: the local compose stack up (docker compose up), the Railway CLI
// logged in, and the repo linked to project `hitch` (railway link). It resolves
// the prod URL from `railway variables --service Postgres --kv` and dumps/
// restores through throwaway postgres:18 client containers (prod runs PG 18, so
// the compose db's own v16 client can't dump it) — no host pg tools needed.
// Secrets (URLs, passwords, keys) are NEVER printed.
//
// Flags:
//   --yes            skip the "this wipes local" confirmation prompt
//   --with-objects   also copy S3 attachment objects prod → local Garage for
//                    the attachment keys present in the DB (default OFF)

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const SKIP_CONFIRM = args.has("--yes");
const WITH_OBJECTS = args.has("--with-objects");

// Prod (Railway) runs Postgres 18, the compose db is postgres:16, and a client
// may not dump a NEWER server. So every dump/restore/query runs through a
// throwaway postgres:18 client container (major ≥ prod), never the host's pg
// tools and never the compose db's own v16 client. The compose db container is
// still detected — the WRITE client joins its network namespace so `localhost`
// inside the client genuinely means the local db (keeps the localhost rail
// honest without publishing the db port).
const PG_CLIENT_IMAGE = "postgres:18";
const DUMP_FILE_IN_CONTAINER = "/work/prod.dump";

// The one connection string this script is ALLOWED to write to. The write
// client joins the compose db's network namespace, so this loopback is always
// the local dev database — never a remote host. Kept as a distinct constant
// from the prod URL so a swap is a visible mistake, and the write helpers
// re-assert it below.
const LOCAL_DATABASE_URL = "postgres://postgres:hitch@localhost:5432/hitch";
const LOCAL_DB_NAME = "hitch";

// ── Safety rails ────────────────────────────────────────────────────────────
// Two independent assertions, applied at the point of use (not just at parse
// time), so no reordering or variable swap can send a WRITE at prod or READ a
// dump from local-masquerading-as-prod.

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error("could not parse a database URL (malformed connection string)");
  }
}
const isLoopback = (host) => host === "localhost" || host === "127.0.0.1" || host === "::1";

// Guards the WRITE side: the target must be local, always. Exported so the
// rail is provable in isolation (see the verification harness).
export function assertLocalTarget(url) {
  if (!isLoopback(hostOf(url))) {
    throw new Error(
      "SAFETY: refusing to write — target database host is not localhost/127.0.0.1. " +
        "This script only ever writes to the local compose DB.",
    );
  }
}
// Guards the READ side: the source must be remote, always. Stops a mis-set env
// from turning "sync from prod" into "read local and treat it as prod".
export function assertRemoteSource(url) {
  if (isLoopback(hostOf(url))) {
    throw new Error(
      "SAFETY: refusing to read — prod source host is localhost/127.0.0.1. " +
        "The prod DATABASE_PUBLIC_URL must be a remote Railway host.",
    );
  }
}

// ── Railway / docker helpers ────────────────────────────────────────────────

function railwayKv(service) {
  const res = spawnSync("railway", ["variables", "--service", service, "--kv"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const hint =
      "run `railway login` and `railway link` (project hitch) first, " +
      "then re-run this script";
    throw new Error(`railway variables --service ${service} failed (${hint})\n${res.stderr ?? ""}`);
  }
  const kv = new Map();
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    kv.set(trimmed.slice(0, eq), trimmed.slice(eq + 1)); // split on FIRST = (values may contain =)
  }
  return kv;
}

function composeDbContainer() {
  const res = spawnSync("docker", ["compose", "ps", "-q", "db"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const id = (res.stdout ?? "").trim().split("\n")[0]?.trim();
  if (res.status !== 0 || !id) {
    throw new Error("local compose db not running — start the stack first (docker compose up)");
  }
  // Confirm it is actually up (ps -q lists created-but-stopped too).
  const state = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", id], {
    encoding: "utf8",
  });
  if ((state.stdout ?? "").trim() !== "true") {
    throw new Error("local compose db is not running — start the stack first (docker compose up)");
  }
  return id;
}

// Run a postgres:18 client in a throwaway container.
//   opts.localTo   — join this container's netns (the compose db), making
//                    `localhost:5432` inside the client the LOCAL db. Set for
//                    every WRITE/local-read; UNSET for the prod dump (which must
//                    reach the public internet and must NOT see the local db).
//   opts.mount     — host dir bind-mounted at /work (for the dump file handoff).
//   opts.env       — passed through with `-e NAME` (no value on argv), so secret
//                    connection strings never appear in `ps`/`docker inspect`.
function runPgClient({ localTo, mount, env = {}, cmd }) {
  const flags = ["run", "--rm"];
  if (localTo) flags.push("--network", `container:${localTo}`);
  if (mount) flags.push("-v", `${mount}:/work`);
  for (const name of Object.keys(env)) flags.push("-e", name);
  const res = spawnSync("docker", [...flags, PG_CLIENT_IMAGE, "sh", "-c", cmd], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ── DB read (prod) and write (local) primitives ─────────────────────────────

// READ side. A prod-only client (no local-db netns) dumps the public schema to
// a host-mounted file. Public holds all app + better-auth data; drizzle's own
// migration-bookkeeping schema is left untouched on both sides.
function dumpProd(sourceUrl, mount) {
  assertRemoteSource(sourceUrl); // READ side rail, at the point of use
  const { code, stderr } = runPgClient({
    mount,
    env: { HITCH_SRC_URL: sourceUrl },
    cmd:
      `pg_dump "$HITCH_SRC_URL" --no-owner --no-privileges --schema=public ` +
      `--format=custom --file=${DUMP_FILE_IN_CONTAINER}`,
  });
  if (code !== 0) throw new Error(`pg_dump of prod failed:\n${stderr}`);
}

// WRITE side. All three steps run in a client that shares the local db's netns,
// so `localhost` is unambiguously the compose db. `mount` (the handoff volume,
// holding the prod dump) is attached to the restore step.
function restoreLocal(dbContainer, targetUrl, mount) {
  assertLocalTarget(targetUrl); // WRITE side rail, at the point of use

  // 1. Drop existing local connections (the dev server's pool/LISTEN included)
  //    so DROP SCHEMA isn't blocked. They reconnect via their own backoff.
  runPgClient({
    localTo: dbContainer,
    env: { HITCH_DST_URL: targetUrl },
    cmd:
      `psql "$HITCH_DST_URL" -v ON_ERROR_STOP=1 -c ` +
      `"SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
      `WHERE datname = '${LOCAL_DB_NAME}' AND pid <> pg_backend_pid();"`,
  });

  // 2. Wipe local schema (all tables + trigger functions live in public).
  const reset = runPgClient({
    localTo: dbContainer,
    env: { HITCH_DST_URL: targetUrl },
    cmd: `psql "$HITCH_DST_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`,
  });
  if (reset.code !== 0) throw new Error(`resetting local public schema failed:\n${reset.stderr}`);

  // 3. Restore the prod dump into the fresh schema. pg_restore is deliberately
  //    NOT run with --exit-on-error: two benign errors are expected and ignored
  //    (see onlyIgnorablePgRestoreErrors) — a v18 archive applied to the v16
  //    local server rejects the preamble `SET transaction_timeout`, and the
  //    dump's own `CREATE SCHEMA public` clashes with the one we just made.
  //    Neither touches the data; the post-restore counts are the real check.
  const restore = runPgClient({
    localTo: dbContainer,
    mount,
    env: { HITCH_DST_URL: targetUrl },
    cmd: `pg_restore --no-owner --no-privileges --dbname="$HITCH_DST_URL" ${DUMP_FILE_IN_CONTAINER}`,
  });
  if (restore.code !== 0 && !onlyIgnorablePgRestoreErrors(restore.stderr)) {
    throw new Error(`pg_restore into local failed:\n${restore.stderr}`);
  }
}

// The two expected complaints of a v18-archive → recreated-public → v16-server
// restore. Anything else on an `error:` line is a real failure.
function onlyIgnorablePgRestoreErrors(stderr) {
  const real = stderr
    .split("\n")
    .filter((l) => /error:/i.test(l))
    .filter((l) => !/transaction_timeout/.test(l))
    .filter((l) => !/schema "public" already exists/.test(l));
  return real.length === 0;
}

// Read-only queries against the LOCAL db (still asserted local so this can never
// be pointed at prod by mistake).
function queryLocal(dbContainer, targetUrl, sql) {
  assertLocalTarget(targetUrl);
  // -A unaligned, default field separator '|'; -t tuples-only (no header/footer).
  const { code, stdout, stderr } = runPgClient({
    localTo: dbContainer,
    env: { HITCH_DST_URL: targetUrl },
    cmd: `psql "$HITCH_DST_URL" -t -A -v ON_ERROR_STOP=1 -c "${sql}"`,
  });
  if (code !== 0) throw new Error(`local query failed:\n${stderr}`);
  return stdout;
}

// Row counts from the LOCAL db, for the post-run summary.
function countLocal(dbContainer, targetUrl) {
  const tables = ["tasks", "projects", "tags", "chats", "assignments"];
  const selects = tables
    // `user` is better-auth's singular, reserved-word table — quote it.
    .map((t) => `SELECT '${t}' AS table, count(*) AS rows FROM ${t}`)
    .concat([`SELECT 'users' AS table, count(*) AS rows FROM \\"user\\"`])
    .join(" UNION ALL ");
  const out = queryLocal(dbContainer, targetUrl, `${selects};`);
  const counts = new Map();
  for (const line of out.split("\n")) {
    const [table, rows] = line.trim().split("|");
    if (table) counts.set(table, Number(rows));
  }
  return counts;
}

// Attachment S3 keys present in the (just-restored) local DB.
function attachmentKeys(dbContainer, targetUrl) {
  const out = queryLocal(dbContainer, targetUrl, "SELECT key FROM attachments;");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

// ── S3 object sync (opt-in, --with-objects) ─────────────────────────────────

function s3ConfigFromRailway(kv) {
  const need = (k) => {
    const v = kv.get(k);
    if (!v) throw new Error(`prod server var ${k} missing — cannot sync objects`);
    return v;
  };
  return {
    endpoint: need("S3_ENDPOINT"),
    region: kv.get("S3_REGION") ?? "us-east-1",
    bucket: need("S3_BUCKET"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: (kv.get("S3_FORCE_PATH_STYLE") ?? "false") !== "false",
  };
}

// Local Garage defaults mirror docker-compose.yml (overridable via the same env
// the compose stack reads). Path-style, localhost:3900.
function localGarageConfig() {
  return {
    endpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:3900",
    region: process.env.S3_REGION ?? "garage",
    bucket: process.env.S3_BUCKET ?? "hitch",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "GKa1b2c3d4e5f60718293a4b5c",
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ??
      "7d4f9a2b1c8e5f30d6a4b2c19e7f5d3a8b6c4e2f0a9d7b5c3e1f8a6d4b2c0e9f",
    forcePathStyle: true,
  };
}

export async function syncObjects(sourceCfg, targetCfg, keys) {
  const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = await import(
    "@aws-sdk/client-s3"
  );
  const clientFor = (cfg) =>
    new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  const src = clientFor(sourceCfg);
  const dst = clientFor(targetCfg);

  let copied = 0;
  let skipped = 0;
  for (const key of keys) {
    const exists = await dst
      .send(new HeadObjectCommand({ Bucket: targetCfg.bucket, Key: key }))
      .then(() => true)
      .catch(() => false);
    if (exists) {
      skipped++;
      continue;
    }
    const obj = await src.send(new GetObjectCommand({ Bucket: sourceCfg.bucket, Key: key }));
    const bytes = Buffer.from(await obj.Body.transformToByteArray());
    await dst.send(
      new PutObjectCommand({
        Bucket: targetCfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: obj.ContentType,
      }),
    );
    copied++;
  }
  return { copied, skipped };
}

// ── main ────────────────────────────────────────────────────────────────────

async function confirm() {
  if (SKIP_CONFIRM) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "This WIPES the local compose database and replaces it with a copy of PROD.\n" +
      "Continue? [y/N] ",
  );
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

async function main() {
  const container = composeDbContainer();

  // Resolve the prod source, validate both endpoints of the pipe up front.
  const prodUrl = railwayKv("Postgres").get("DATABASE_PUBLIC_URL");
  if (!prodUrl) {
    throw new Error(
      "DATABASE_PUBLIC_URL not found on the Postgres service — is the repo linked to project hitch?",
    );
  }
  assertRemoteSource(prodUrl); // fail before touching anything if prod looks local
  assertLocalTarget(LOCAL_DATABASE_URL); // fail before touching anything if target looks remote

  console.log("Sync local ← prod");
  console.log(`  source:  Railway Postgres (${hostOf(prodUrl)}, remote)  [READ ONLY]`);
  console.log(`  target:  local compose db (${hostOf(LOCAL_DATABASE_URL)}, container ${container.slice(0, 12)})  [WRITE]`);
  console.log(`  objects: ${WITH_OBJECTS ? "yes (--with-objects)" : "no (pass --with-objects to copy attachments)"}`);

  if (!(await confirm())) {
    console.log("Aborted — nothing changed.");
    return;
  }

  // A throwaway docker volume carries the dump file between the two client
  // containers — host-FS-agnostic (no bind-mount / Docker Desktop file-sharing
  // dependency).
  const volume = `hitch-sync-${process.pid}`;
  spawnSync("docker", ["volume", "create", volume], { encoding: "utf8" });
  try {
    console.log("\n→ dumping prod (read-only)…");
    dumpProd(prodUrl, volume);

    console.log("→ wiping + restoring local…");
    console.log("  (existing local connections are terminated; the dev server's pool/LISTEN will reconnect on its own backoff)");
    restoreLocal(container, LOCAL_DATABASE_URL, volume);
  } finally {
    spawnSync("docker", ["volume", "rm", "-f", volume], { encoding: "utf8" });
  }

  const counts = countLocal(container, LOCAL_DATABASE_URL);
  console.log("\nLocal now mirrors prod:");
  for (const table of ["projects", "tasks", "tags", "chats", "assignments", "users"]) {
    console.log(`  ${table.padEnd(12)} ${counts.get(table) ?? 0}`);
  }

  const keys = attachmentKeys(container, LOCAL_DATABASE_URL);
  if (WITH_OBJECTS) {
    console.log(`\n→ syncing ${keys.length} attachment object(s) prod → local Garage…`);
    const prodS3 = s3ConfigFromRailway(railwayKv("server"));
    const localS3 = localGarageConfig();
    const { copied, skipped } = await syncObjects(prodS3, localS3, keys);
    console.log(`  objects: ${copied} copied, ${skipped} already present`);
  } else if (keys.length > 0) {
    console.log(
      `\nNote: ${keys.length} attachment(s) reference S3 objects that were NOT copied. ` +
        "Attachment previews need the objects — re-run with --with-objects.",
    );
  }

  console.log("\nDone.");
}

// Auto-run only as the CLI entry point, so the rails above can be imported and
// exercised without kicking off a real sync.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `\nsync-local-from-prod failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
