import { describe, expect, it } from "vitest";

import { taskAgentPrompt } from "../agentPrompt";

describe("taskAgentPrompt", () => {
  it("copies a self-contained existing-chat handoff with the full task id", () => {
    const id = "0198c2a4-0000-7000-8000-000000000001";
    expect(taskAgentPrompt(id)).toBe(
      `Take Hitch task ${id}. ` +
        `Run \`hitch tasks link ${id} --json\` to attach this chat and load the task.`,
    );
  });
});
