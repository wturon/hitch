import assert from "node:assert/strict";
import {
  CHAT_TITLE_MAX_LENGTH,
  normalizeChatTitle,
  titleFromInitialPrompt,
  untitledChatTitle,
} from "../src/chatTitles.js";

assert.equal(untitledChatTitle("codex"), "Untitled Codex chat");
assert.equal(untitledChatTitle("claude-code"), "Untitled Claude Code chat");

assert.equal(titleFromInitialPrompt("", "codex"), "Untitled Codex chat");
assert.equal(
  titleFromInitialPrompt(" \n\t  ", "claude-code"),
  "Untitled Claude Code chat",
);
assert.equal(
  titleFromInitialPrompt("  Review   this\n\nschema change\tplease  ", "codex"),
  "Review this schema change please",
);
assert.equal(
  titleFromInitialPrompt("Line one\nLine two\r\nLine three", "codex"),
  "Line one Line two Line three",
);

const exact = "x".repeat(CHAT_TITLE_MAX_LENGTH);
assert.equal(titleFromInitialPrompt(exact, "codex"), exact);

const longPrompt = "Summarize " + "a".repeat(100);
const title = titleFromInitialPrompt(longPrompt, "codex");
assert.equal(title.length, CHAT_TITLE_MAX_LENGTH);
assert.equal(title.endsWith("..."), true);
assert.equal(title, `${longPrompt.slice(0, CHAT_TITLE_MAX_LENGTH - 3)}...`);

assert.equal(
  normalizeChatTitle("   Custom\nexternal\tname   ", "claude-code"),
  "Custom external name",
);
assert.equal(normalizeChatTitle(undefined, "codex"), "Untitled Codex chat");

console.log("chat title smoke passed");
