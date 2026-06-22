import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";

const fixtureDir = resolve(
  import.meta.dirname,
  "../../docs/fixtures/chat-lifecycle-hooks",
);

const STATUS_BY_HOOK_EVENT = {
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PermissionRequest: "needs-input",
  Notification: "needs-input",
  Stop: "waiting",
  SessionStart: null,
  SessionEnd: null,
} as const;

const LIFECYCLE_BY_HOOK_EVENT = {
  UserPromptSubmit: "turn.started",
  PreToolUse: "turn.resumed",
  PermissionRequest: "turn.needs_input",
  Notification: "turn.needs_input",
  Stop: "turn.completed",
  SessionStart: "session.started",
  SessionEnd: "session.ended",
} as const;

type HookEvent = keyof typeof LIFECYCLE_BY_HOOK_EVENT;

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function harnessFromFixtureName(name: string): "codex" | "claude-code" {
  if (name.startsWith("codex-")) return "codex";
  if (name.startsWith("claude-")) return "claude-code";
  throw new Error(`Cannot infer harness from ${name}`);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function chatId(payload: Record<string, unknown>): string | null {
  return (
    stringField(payload.session_id) ??
    stringField(payload.sessionId) ??
    stringField(payload.thread_id) ??
    stringField(payload.threadId)
  );
}

function metadata(payload: Record<string, unknown>, providerEvent: HookEvent) {
  const out: Record<string, unknown> = {};
  const toolName = stringField(payload.tool_name) ?? stringField(payload.toolName);
  if (toolName) out.toolName = toolName;
  const notificationType = stringField(payload.notification_type);
  if (notificationType) out.notificationType = notificationType;
  if (providerEvent === "SessionStart") {
    const source = stringField(payload.source);
    const model = stringField(payload.model);
    const title = stringField(payload.session_title);
    if (source) out.source = source;
    if (model) out.model = model;
    if (title) out.title = title;
  }
  if (providerEvent === "SessionEnd") {
    const reason = stringField(payload.reason);
    if (reason) out.reason = reason;
  }
  return out;
}

function normalizeHookPayload(payload: Record<string, unknown>, fixtureName: string) {
  const harness = harnessFromFixtureName(fixtureName);
  const providerEvent = stringField(payload.hook_event_name) as HookEvent | null;
  assert.ok(providerEvent, `${fixtureName}: missing hook event name`);
  assert.ok(
    providerEvent in LIFECYCLE_BY_HOOK_EVENT,
    `${fixtureName}: unsupported hook event ${providerEvent}`,
  );
  if (
    harness === "claude-code" &&
    providerEvent === "Notification" &&
    payload.notification_type !== "permission_prompt"
  ) {
    return null;
  }

  const id = chatId(payload);
  assert.ok(id, `${fixtureName}: missing chat id`);
  const cwd = stringField(payload.cwd);
  assert.ok(cwd, `${fixtureName}: missing cwd`);

  const rawPayloadHash = stableHash(payload);
  const turnId = stringField(payload.turn_id) ?? stringField(payload.turnId);
  const toolUseId = stringField(payload.tool_use_id) ?? stringField(payload.toolUseId);

  return {
    schemaVersion: 1 as const,
    eventId: stableHash({
      source: "hook",
      producer: `${harness}-hook`,
      harness,
      providerEvent,
      chatId: id,
      launchId: null,
      turnId,
      toolUseId,
      status: STATUS_BY_HOOK_EVENT[providerEvent],
      rawPayloadHash,
    }),
    source: "hook" as const,
    producer: `${harness}-hook` as "codex-hook" | "claude-code-hook",
    harness,
    providerEvent,
    lifecycle: LIFECYCLE_BY_HOOK_EVENT[providerEvent],
    status: STATUS_BY_HOOK_EVENT[providerEvent],
    projectId: "project-fixture",
    projectLocalPath: "/Users/example/project",
    chatId: id,
    launchId: null,
    turnId,
    cwd,
    host: hostname(),
    observedAt: "2026-06-22T00:00:00.000Z",
    rawPayloadHash,
    rawPayloadRef: null,
    metadata: metadata(payload, providerEvent),
  };
}

const tempDir = mkdtempSync(join(tmpdir(), "hitch-chat-hook-fixtures-"));

try {
  const store = openChatLifecycleStore({ appSupportDir: tempDir });
  const files = readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  let inserted = 0;

  for (const file of files) {
    const payload = JSON.parse(
      readFileSync(join(fixtureDir, file), "utf8"),
    ) as Record<string, unknown>;
    const event = normalizeHookPayload(payload, basename(file));
    if (!event) continue;

    const result = store.insertLifecycleEvent(event);
    assert.equal(result.inserted, true, `${file}: first insert`);
    assert.equal(store.insertLifecycleEvent(event).inserted, false, `${file}: dedupe`);
    inserted += 1;
  }

  const events = store.readEventsAfter(0);
  assert.equal(events.length, inserted);
  assert.equal(events.length, 10);
  assert.deepEqual(
    events.map((event) => [event.harness, event.providerEvent, event.lifecycle, event.status]),
    [
      ["claude-code", "Notification", "turn.needs_input", "needs-input"],
      ["claude-code", "PreToolUse", "turn.resumed", "working"],
      ["claude-code", "SessionEnd", "session.ended", null],
      ["claude-code", "SessionStart", "session.started", null],
      ["claude-code", "Stop", "turn.completed", "waiting"],
      ["claude-code", "UserPromptSubmit", "turn.started", "working"],
      ["codex", "PermissionRequest", "turn.needs_input", "needs-input"],
      ["codex", "PreToolUse", "turn.resumed", "working"],
      ["codex", "Stop", "turn.completed", "waiting"],
      ["codex", "UserPromptSubmit", "turn.started", "working"],
    ],
  );
  assert.ok(store.paths.bumpPath.endsWith("chat-lifecycle.bump"));
  store.close();
  console.log(`chat lifecycle hook fixtures smoke passed (${inserted} events)`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
