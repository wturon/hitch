import { toast } from "sonner";

// The "out" direction of Hitch's interop, and deliberately the dumbest possible
// version of it: a task rendered as plain markdown, on the clipboard. Every
// agent surface — cmux, a browser chat, whatever ships next — accepts pasted
// text, so this integrates with all of them at once and with none of them
// specifically. Zero new state, zero API surface.
//
// What is NOT in the output, on purpose:
//   - the task id / a link back. The paste target is a foreign tool that can do
//     nothing with a Hitch id. `taskAgentPrompt` (agentPrompt.ts) owns the
//     hand-an-agent-the-id job, and the two actions stay legible only while
//     they stay distinct.
//   - tags. They are Hitch-side filing, not content.
//
// The body goes out VERBATIM — same contract the server's PATCH honours
// ("never trim/transform the body"). A body that already opens with its own `#`
// heading therefore yields two H1s; that is the correct trade, because the
// alternative is rewriting the user's text on the way to the clipboard.
export function taskMarkdown({
  title,
  body,
}: {
  title: string;
  body: string;
}): string {
  const heading = title.trim() === "" ? "" : `# ${title.trim()}`;
  // Either half may be empty (an untitled capture, a title with no body), and
  // neither should leave a lone `#` or a trailing blank line behind.
  return [heading, body.trim()].filter(Boolean).join("\n\n");
}

export async function copyTaskMarkdown(
  task: { title: string; body: string },
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
): Promise<void> {
  try {
    await clipboard.writeText(taskMarkdown(task));
    toast.success("Copied as markdown");
  } catch {
    toast.error("Could not copy task");
  }
}
