import { toast } from "sonner";

export function taskAgentPrompt(taskId: string): string {
  return (
    `Take Hitch task ${taskId}. ` +
    `Run \`hitch tasks link ${taskId} --json\` to attach this chat and load the task.`
  );
}

export async function copyTaskAgentPrompt(
  taskId: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
): Promise<void> {
  try {
    await clipboard.writeText(taskAgentPrompt(taskId));
    toast.success("Agent prompt copied");
  } catch {
    toast.error("Could not copy agent prompt");
  }
}
