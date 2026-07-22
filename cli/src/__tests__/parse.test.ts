import { describe, expect, it } from "vitest";

import { UsageError } from "../errors.js";
import { onePositional, parseFlags } from "../parse.js";

describe("parseFlags", () => {
  it("parses declared flags plus the built-in --json/--help", () => {
    const { values, positionals } = parseFlags(
      ["show", "0198c2a4", "--project", "Inbox", "--json"],
      { project: { type: "string" } },
      "USAGE",
    );
    expect(values.project).toBe("Inbox");
    expect(values.json).toBe(true);
    expect(values.help).toBe(false);
    expect(positionals).toEqual(["show", "0198c2a4"]);
  });

  it("collects repeated flags when declared multiple", () => {
    const { values } = parseFlags(
      ["--tag", "bug", "--tag", "infra"],
      { tag: { type: "string", multiple: true } },
      "USAGE",
    );
    expect(values.tag).toEqual(["bug", "infra"]);
  });

  it("turns an unknown flag into a UsageError carrying the usage text", () => {
    expect(() => parseFlags(["--nope"], {}, "THE USAGE TEXT")).toThrowError(UsageError);
    try {
      parseFlags(["--nope"], {}, "THE USAGE TEXT");
    } catch (error) {
      expect((error as Error).message).toContain("--nope");
      expect((error as Error).message).toContain("THE USAGE TEXT");
    }
  });

  it("turns a flag missing its value into a UsageError", () => {
    expect(() => parseFlags(["--project"], { project: { type: "string" } }, "USAGE")).toThrowError(
      UsageError,
    );
  });
});

describe("onePositional", () => {
  it("returns the single positional", () => {
    expect(onePositional(["0198c2a4"], "task id", "hitch tasks show 0198c2a4")).toBe("0198c2a4");
  });

  it("teaches the exact invocation when the positional is missing", () => {
    try {
      onePositional([], "task id", "hitch tasks show 0198c2a4");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain("hitch tasks show 0198c2a4");
    }
  });

  it("teaches quoting when extra positionals appear (unquoted titles)", () => {
    try {
      onePositional(["Fix", "the", "bug"], "task title", 'hitch tasks add "Fix the bug"');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain("Quote arguments");
      expect((error as Error).message).toContain('hitch tasks add "Fix the bug"');
    }
  });
});
