#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = fileURLToPath(
  new URL("../docs/fixtures/chat-lifecycle-hooks/", import.meta.url),
);

const STATUS_BY_HOOK_EVENT = {
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PermissionRequest: "needs-input",
  Notification: "needs-input",
  Stop: "waiting",
  SessionStart: null,
  SessionEnd: null,
};

const LIFECYCLE_BY_HOOK_EVENT = {
  UserPromptSubmit: "turn.started",
  PreToolUse: "turn.resumed",
  PermissionRequest: "turn.needs_input",
  Notification: "turn.needs_input",
  Stop: "turn.completed",
  SessionStart: "session.started",
  SessionEnd: "session.ended",
};

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function harnessFromFixtureName(name) {
  if (name.startsWith("codex-")) return "codex";
  if (name.startsWith("claude-")) return "claude-code";
  throw new Error(`Cannot infer harness from ${name}`);
}

function chatId(payload) {
  return payload.session_id ?? payload.sessionId ?? payload.thread_id ?? payload.threadId;
}

function normalizeHookPayload(payload, fixtureName) {
  const harness = harnessFromFixtureName(fixtureName);
  const providerEvent = payload.hook_event_name ?? payload.hookEventName;
  if (!providerEvent) throw new Error(`${fixtureName}: missing hook event name`);
  if (!(providerEvent in LIFECYCLE_BY_HOOK_EVENT)) {
    throw new Error(`${fixtureName}: unsupported hook event ${providerEvent}`);
  }
  if (
    harness === "claude-code" &&
    providerEvent === "Notification" &&
    payload.notification_type !== "permission_prompt"
  ) {
    return null;
  }

  const id = chatId(payload);
  if (!id) throw new Error(`${fixtureName}: missing chat id`);
  if (!payload.cwd) throw new Error(`${fixtureName}: missing cwd`);

  const status = STATUS_BY_HOOK_EVENT[providerEvent];
  const rawHash = stableHash(payload);
  const event = {
    schemaVersion: 1,
    eventId: stableHash({
      harness,
      providerEvent,
      chatId: id,
      turnId: payload.turn_id ?? payload.turnId ?? null,
      toolUseId: payload.tool_use_id ?? payload.toolUseId ?? null,
      rawHash,
    }),
    source: "hook",
    producer: `${harness}-hook`,
    harness,
    providerEvent,
    lifecycle: LIFECYCLE_BY_HOOK_EVENT[providerEvent],
    status,
    chatId: id,
    launchId: null,
    turnId: payload.turn_id ?? payload.turnId ?? null,
    cwd: payload.cwd,
    host: "example-host.local",
    observedAt: "2026-06-22T00:00:00.000Z",
    rawPayloadHash: rawHash,
    rawPayloadRef: null,
    metadata: {},
  };

  if (providerEvent === "SessionEnd") event.metadata.reason = payload.reason ?? null;
  if (providerEvent === "SessionStart") event.metadata.source = payload.source ?? null;
  if (payload.tool_name) event.metadata.toolName = payload.tool_name;
  if (payload.notification_type) event.metadata.notificationType = payload.notification_type;

  return event;
}

const files = (await readdir(fixtureDir))
  .filter((file) => file.endsWith(".json"))
  .sort();

const normalized = [];
for (const file of files) {
  const payload = JSON.parse(await readFile(join(fixtureDir, file), "utf8"));
  const event = normalizeHookPayload(payload, basename(file));
  if (event) normalized.push({ fixture: file, event });
}

for (const { fixture, event } of normalized) {
  console.log(`${fixture} -> ${event.harness} ${event.providerEvent} ${event.status ?? "no-status"}`);
}

console.log(`normalized ${normalized.length} fixture(s)`);
