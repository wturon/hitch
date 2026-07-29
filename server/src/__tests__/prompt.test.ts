import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROMPT_TEMPLATE,
  EMPTY_BODY_PLACEHOLDER,
  PROMPT_TEMPLATE_FRAMING,
  resolvePromptTemplate,
} from "../prompt.js";

const task = { id: "task-123", title: "Fix the login bug", body: "Do the thing." };

describe("resolvePromptTemplate", () => {
  it("substitutes all three variables", () => {
    const out = resolvePromptTemplate(
      "$TASK_TITLE / $TASK_BODY / $TASK_ID",
      task,
    );
    expect(out).toBe("Fix the login bug / Do the thing. / task-123");
  });

  it("embeds the body byte-for-byte (capture text is sacred)", () => {
    const body = "Line one.\n\n  Indented — keep the  spacing.\n\tTabbed.\n";
    const out = resolvePromptTemplate("before\n$TASK_BODY\nafter", { ...task, body });
    expect(out).toBe(`before\n${body}\nafter`);
  });

  it("uses the placeholder for an empty or whitespace body", () => {
    expect(resolvePromptTemplate("$TASK_BODY", { ...task, body: "" })).toBe(
      EMPTY_BODY_PLACEHOLDER,
    );
    expect(resolvePromptTemplate("$TASK_BODY", { ...task, body: "  \n " })).toBe(
      EMPTY_BODY_PLACEHOLDER,
    );
  });

  // SINGLE PASS: a task body that itself contains variable syntax is data, not
  // template. Expanding it again would let task text rewrite the prompt around
  // it — the substitution equivalent of an injection.
  it("never re-expands variables that came from the task", () => {
    const out = resolvePromptTemplate("$TASK_BODY", {
      ...task,
      body: "$TASK_TITLE and $TASK_ID",
    });
    expect(out).toBe("$TASK_TITLE and $TASK_ID");
  });

  // A function replacer, so `$&` / `$1` / `$'` in a body are literal text
  // rather than JS replacement patterns.
  it("treats replacement syntax in the task as literal", () => {
    const out = resolvePromptTemplate("[$TASK_BODY]", {
      ...task,
      body: "$& $1 $' $$",
    });
    expect(out).toBe("[$& $1 $' $$]");
  });

  it("leaves unknown variables and partial names alone", () => {
    expect(resolvePromptTemplate("$TASK_REPO $NOPE", task)).toBe("$TASK_REPO $NOPE");
    // \b guards the suffix case: $TASK_IDENTIFIER is not $TASK_ID + "ENTIFIER".
    expect(resolvePromptTemplate("$TASK_IDENTIFIER", task)).toBe("$TASK_IDENTIFIER");
    expect(resolvePromptTemplate("$TASK_TITLES", task)).toBe("$TASK_TITLES");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(resolvePromptTemplate("$TASK_ID $TASK_ID", task)).toBe(
      "task-123 task-123",
    );
  });

  it("passes a variable-free template through untouched", () => {
    expect(resolvePromptTemplate("just do it", task)).toBe("just do it");
    expect(resolvePromptTemplate("", task)).toBe("");
  });
});

describe("the shipped templates", () => {
  it("the default template carries the task, not just an instruction", () => {
    expect(DEFAULT_PROMPT_TEMPLATE.startsWith(PROMPT_TEMPLATE_FRAMING)).toBe(true);
    const resolved = resolvePromptTemplate(DEFAULT_PROMPT_TEMPLATE, task);
    expect(resolved).toContain('"Fix the login bug"');
    expect(resolved).toContain("Do the thing.");
    expect(resolved).toContain("Task id: task-123");
    expect(resolved).not.toContain("hitch");
    expect(resolved).not.toMatch(/\bmark(?: it| the task)? done\b/i);
    // Nothing left unsubstituted — a stray $TASK_ would reach the agent raw.
    expect(resolved).not.toContain("$TASK_");
  });
});
