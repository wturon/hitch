// Prompt templates: the one place a delegation prompt is composed.
//
// THE HONESTY CONTRACT. What a user sees in the delegate bar is the whole
// prompt — there is no preamble bolted on behind their back. To keep the
// editable text short (the task body is already on screen, six inches above the
// bar) a template refers to the task through variables, which are substituted
// here, once, when the assignment row is created.
//
// Resolution happens SERVER-SIDE and at CREATION time, not at spawn time:
//
//   • one resolver for every creator — desktop, CLI, automations — instead of a
//     copy per client that drifts (there used to be two, and the daemon's copy
//     carried a comment asking a human to keep them in sync by hand);
//   • assignments.prompt becomes an immutable record of what was actually sent.
//     Edit the task afterwards and the launched prompt does not retroactively
//     change, which is what you want when you're reading back what an agent was
//     told;
//   • the daemon goes back to being a pure consumer of a string.

/** The variables a template may use. Deliberately small — see AGENTS.md. */
export const PROMPT_VARIABLES = ["TASK_TITLE", "TASK_BODY", "TASK_ID"] as const;

export interface PromptTask {
  id: string;
  title: string;
  body: string;
}

// Shown in place of $TASK_BODY when a task has no description. A bare empty
// string would leave a hole in the middle of the prompt that reads like the
// template broke; this says plainly that there was nothing to include.
export const EMPTY_BODY_PLACEHOLDER = "(No description was written.)";

// SINGLE PASS, and a function replacer rather than a string one. Both matter:
// a function replacer means `$&`/`$1` inside a task body are never interpreted
// as replacement syntax, and one pass means a body containing the literal text
// "$TASK_TITLE" is left alone instead of expanding a second time.
//
// \b keeps `$TASK_IDENTIFIER` from matching `$TASK_ID` plus stray text.
const VARIABLE_RE = new RegExp(`\\$(${PROMPT_VARIABLES.join("|")})\\b`, "g");

export function resolvePromptTemplate(template: string, task: PromptTask): string {
  return template.replace(VARIABLE_RE, (_match, name: string) => {
    switch (name) {
      case "TASK_TITLE":
        return task.title;
      case "TASK_BODY":
        return task.body.trim() === "" ? EMPTY_BODY_PLACEHOLDER : task.body;
      case "TASK_ID":
        return task.id;
      default:
        return _match;
    }
  });
}

// The orienting header every built-in prompt opens with: who you are, the task
// verbatim, and how to write back. Exported (through @hitch/shared) so the
// desktop's built-in presets are built from this exact text rather than a
// second copy of it — a preset is framing + one instruction stanza.
export const PROMPT_TEMPLATE_FRAMING = [
  `You're picking up the Hitch task "$TASK_TITLE".`,
  "",
  "$TASK_BODY",
  "",
  "Task id: $TASK_ID",
  "The `hitch` CLI can read this task, comment on it, and mark it done — run" +
    " `hitch --help` to see how.",
].join("\n");

// Used when an assignment is created without a template at all (the CLI and
// automations today). Identical to the desktop's "Do the task." preset.
export const DEFAULT_PROMPT_TEMPLATE = `${PROMPT_TEMPLATE_FRAMING}\n\nRead this task and do what it asks.`;
