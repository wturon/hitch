#!/bin/sh
# First-boot init for the Garage `storage` service, run by the `storage-init`
# sidecar (curl image — the Garage image has no shell). Talks to Garage's
# admin API and is idempotent: safe on every `docker compose up`.
#
# Steps:
#   1. wait for the admin API
#   2. single-node layout (assign this node, apply) — only when layout v0
#   3. import the server's S3 key (409 = already imported)
#   4. create the bucket           (409 = already created)
#   5. grant the key read/write/owner on the bucket (idempotent)
#   6. permissive CORS on the bucket (PutBucketCors overwrites — idempotent)
#
# Env (wired in docker-compose.yml): GARAGE_ADMIN_TOKEN, S3_ACCESS_KEY_ID,
# S3_SECRET_ACCESS_KEY, S3_BUCKET, and optionally GARAGE_ADMIN_URL.
set -eu

ADMIN_URL="${GARAGE_ADMIN_URL:-http://storage:3903}"
auth="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"

echo "[garage-init] waiting for garage admin api at $ADMIN_URL ..."
until curl -sf "$ADMIN_URL/health" >/dev/null 2>&1; do sleep 1; done

# --- layout ------------------------------------------------------------------
layout_version=$(curl -sf -H "$auth" "$ADMIN_URL/v1/layout" \
  | sed -n 's/.*"version": *\([0-9]*\).*/\1/p' | head -n1)
if [ "$layout_version" = "0" ]; then
  node_id=$(curl -sf -H "$auth" "$ADMIN_URL/v1/status" \
    | sed -n 's/.*"node": *"\([0-9a-f]*\)".*/\1/p' | head -n1)
  echo "[garage-init] assigning single-node layout to $node_id"
  # capacity is a placement weight, not a quota — any value works on one node.
  curl -sf -H "$auth" -X POST "$ADMIN_URL/v1/layout" \
    -d "[{\"id\":\"$node_id\",\"zone\":\"dc1\",\"capacity\":1000000000,\"tags\":[\"hitch\"]}]" >/dev/null
  curl -sf -H "$auth" -X POST "$ADMIN_URL/v1/layout/apply" \
    -d '{"version":1}' >/dev/null
else
  echo "[garage-init] layout already applied (version $layout_version)"
fi

# --- key ---------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" -X POST "$ADMIN_URL/v1/key/import" \
  -d "{\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"secretAccessKey\":\"$S3_SECRET_ACCESS_KEY\",\"name\":\"hitch-server\"}")
case "$code" in
  200) echo "[garage-init] imported key $S3_ACCESS_KEY_ID" ;;
  409) echo "[garage-init] key already imported" ;;
  *) echo "[garage-init] key import failed with $code" >&2; exit 1 ;;
esac

# --- bucket ------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" -X POST "$ADMIN_URL/v1/bucket" \
  -d "{\"globalAlias\":\"$S3_BUCKET\"}")
case "$code" in
  200) echo "[garage-init] created bucket $S3_BUCKET" ;;
  409) echo "[garage-init] bucket already exists" ;;
  *) echo "[garage-init] bucket create failed with $code" >&2; exit 1 ;;
esac

bucket_id=$(curl -sf -H "$auth" "$ADMIN_URL/v1/bucket?globalAlias=$S3_BUCKET" \
  | sed -n 's/.*"id": *"\([0-9a-f]*\)".*/\1/p' | head -n1)
curl -sf -H "$auth" -X POST "$ADMIN_URL/v1/bucket/allow" \
  -d "{\"bucketId\":\"$bucket_id\",\"accessKeyId\":\"$S3_ACCESS_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null

# --- cors --------------------------------------------------------------------
# Permissive CORS so the renderer can hit presigned PUT/GET URLs straight from
# the browser context — dev origin http://127.0.0.1:5173 and the packaged
# app's file:// null origin, hence "*" (fine: presigned URLs carry their own
# auth, no cookies involved). The admin API has no CORS endpoint, so this goes
# through the S3 API's PutBucketCors, signed with curl's built-in sigv4
# ("garage" = s3_region in garage.toml). Runs after step 5 — the key needs its
# owner grant to write bucket config.
S3_URL="${GARAGE_S3_URL:-http://storage:3900}"
curl -sf --aws-sigv4 "aws:amz:garage:s3" \
  --user "$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY" \
  -X PUT "$S3_URL/$S3_BUCKET?cors" -H "Content-Type: application/xml" \
  -d '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>' \
  >/dev/null
echo "[garage-init] permissive CORS applied to $S3_BUCKET"

echo "[garage-init] done — bucket $S3_BUCKET ready for $S3_ACCESS_KEY_ID"
