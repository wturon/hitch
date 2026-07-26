// @vitest-environment jsdom
//
// The project settings dialog's state lifecycle. It is a SINGLE mount driven by
// which project is being edited, so most of what can go wrong here is state
// leaking between opens or being clobbered by a re-render — neither of which
// shows up as a crash, only as the wrong value silently saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CreateProjectDialog } from "../CreateProjectDialog";
import { ProjectSettingsDialog } from "../ProjectSettingsDialog";

const HOME = "/Users/tester";

function installBridge(exists: (path: string) => boolean = () => true) {
  const chooseDirectory = vi.fn().mockResolvedValue(null);
  (window as unknown as { hitchDaemon?: unknown }).hitchDaemon = {
    chooseDirectory,
    getHomeDir: vi.fn().mockResolvedValue(HOME),
    directoryExists: vi.fn(async (path: string) => exists(path)),
  };
  return { chooseDirectory };
}

const alpha = { id: "p1", name: "Alpha", repoPath: "/code/alpha" };
const beta = { id: "p2", name: "Beta", repoPath: null };

function pathInput() {
  return screen.getByLabelText("Working directory") as HTMLInputElement;
}
function nameInput() {
  return screen.getByLabelText("Name") as HTMLInputElement;
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => installBridge());
afterEach(() => {
  cleanup();
  delete (window as unknown as { hitchDaemon?: unknown }).hitchDaemon;
  vi.restoreAllMocks();
});

describe("seeding", () => {
  it("fills both fields from the project", async () => {
    render(
      <ProjectSettingsDialog
        project={alpha}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Alpha"));
    expect(pathInput().value).toBe("/code/alpha");
  });

  // `project` comes from a react-query list that hands back a NEW object on
  // every refetch, and this app refetches projects on every WS invalidation.
  // Depending on the object identity would wipe whatever was being typed.
  it("does NOT re-seed when the same project arrives as a new object", async () => {
    const { rerender } = render(
      <ProjectSettingsDialog project={alpha} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Alpha"));

    fireEvent.change(nameInput(), { target: { value: "My New Name" } });
    rerender(
      <ProjectSettingsDialog
        project={{ ...alpha }}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(nameInput().value).toBe("My New Name");
  });

  it("DOES re-seed when a different project is opened", async () => {
    const { rerender } = render(
      <ProjectSettingsDialog project={alpha} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Alpha"));
    fireEvent.change(nameInput(), { target: { value: "scratch" } });

    rerender(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Beta"));
    expect(pathInput().value).toBe("");
  });
});

describe("the working directory", () => {
  it("names the real home folder rather than describing it", async () => {
    render(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText(HOME)).toBeTruthy());
  });

  it("saves null for an empty or whitespace path, never an empty string", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSettingsDialog project={alpha} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    await waitFor(() => expect(pathInput().value).toBe("/code/alpha"));
    fireEvent.change(pathInput(), { target: { value: "   " } });
    await act(async () => save());
    expect(onSave).toHaveBeenCalledWith({ repoPath: null });
  });

  // A path handed to a shell single-quoted, so `~` is never expanded: `cd
  // '~/code/x'` fails and the agent never starts, with nothing explaining why.
  it("refuses a ~ path instead of saving something that can never work", async () => {
    const onSave = vi.fn();
    render(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Beta"));
    fireEvent.change(pathInput(), { target: { value: "~/code/beta" } });
    await act(async () => save());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/full path starting with/i)).toBeTruthy();
  });

  it("refuses a relative path, which would resolve against the daemon's cwd", async () => {
    const onSave = vi.fn();
    render(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Beta"));
    fireEvent.change(pathInput(), { target: { value: "code/beta" } });
    await act(async () => save());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("warns about a missing absolute folder but still allows saving it", async () => {
    installBridge((path) => path !== "/nope/gone");
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Beta"));
    fireEvent.change(pathInput(), { target: { value: "/nope/gone" } });
    await waitFor(() => expect(screen.getByText(/No such folder/i)).toBeTruthy());
    await act(async () => save());
    expect(onSave).toHaveBeenCalledWith({ repoPath: "/nope/gone" });
  });

  it("clears a stale missing-folder warning when the dialog is reopened", async () => {
    installBridge((path) => path !== "/nope/gone");
    const { rerender } = render(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Beta"));
    fireEvent.change(pathInput(), { target: { value: "/nope/gone" } });
    await waitFor(() => expect(screen.getByText(/No such folder/i)).toBeTruthy());

    // Switch to a project whose saved path is fine — the warning must not ride
    // along and alarm the user about a perfectly good directory.
    rerender(
      <ProjectSettingsDialog project={alpha} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.queryByText(/No such folder/i)).toBeNull();
  });
});

describe("the name", () => {
  // Inbox is identified BY NAME: ensured on boot, pinned first, and rendered
  // without a settings menu. Renaming into it would strand the project with no
  // way back from the UI.
  it("refuses to rename a project to the reserved Inbox name", async () => {
    const onSave = vi.fn();
    render(
      <ProjectSettingsDialog project={alpha} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Alpha"));
    for (const reserved of ["Inbox", "inbox", "  INBOX  "]) {
      fireEvent.change(nameInput(), { target: { value: reserved } });
      await act(async () => save());
    }
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/reserved/i)).toBeTruthy();
  });
});

describe("saving", () => {
  // The dialog holds a snapshot from when it opened, so sending every field
  // would revert a concurrent edit to the one the user never touched.
  it("sends only the fields that changed", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSettingsDialog project={alpha} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Alpha"));
    fireEvent.change(nameInput(), { target: { value: "Renamed" } });
    await act(async () => save());
    expect(onSave).toHaveBeenCalledWith({ name: "Renamed" });
  });

  it("keeps the dialog open and shows why when the save fails", async () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("Failed to save project (404)"));
    render(
      <ProjectSettingsDialog project={alpha} open onOpenChange={onOpenChange} onSave={onSave} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Alpha"));
    fireEvent.change(nameInput(), { target: { value: "Renamed" } });
    await act(async () => save());
    await waitFor(() =>
      expect(screen.getByText("Failed to save project (404)")).toBeTruthy(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The edit survives, so a retry doesn't start from scratch.
    expect(nameInput().value).toBe("Renamed");
  });

  it("reports a folder picker that fails instead of doing nothing", async () => {
    (window as unknown as { hitchDaemon?: unknown }).hitchDaemon = {
      chooseDirectory: vi.fn().mockRejectedValue(new Error("window gone")),
      getHomeDir: vi.fn().mockResolvedValue(HOME),
      directoryExists: vi.fn().mockResolvedValue(true),
    };
    render(
      <ProjectSettingsDialog project={beta} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Beta"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    });
    await waitFor(() =>
      expect(screen.getByText(/Couldn't open the folder picker/i)).toBeTruthy(),
    );
  });
});

// The reserved name has to hold at BOTH doors that set one. Guarding only the
// settings dialog left the New-project dialog (also reachable from ⌘K) able to
// create a second "Inbox", which renders as an inbox — losing the context menu
// that is the only route to its own settings, permanently.
describe("CreateProjectDialog and the reserved name", () => {
  it("refuses to create a second Inbox", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateProjectDialog open onOpenChange={vi.fn()} creating={false} onCreate={onCreate} />,
    );
    const field = screen.getByPlaceholderText("Project name");
    for (const reserved of ["Inbox", "inbox", "  INBOX  "]) {
      fireEvent.change(field, { target: { value: reserved } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create project" }));
      });
    }
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/reserved/i)).toBeTruthy();
  });

  it("still creates any other project", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateProjectDialog open onOpenChange={vi.fn()} creating={false} onCreate={onCreate} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "Inboxes and Outboxes" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    });
    expect(onCreate).toHaveBeenCalledWith("Inboxes and Outboxes");
  });
});

// A project literally named "Inbox " (trailing space) renders as an ordinary
// project, so it HAS a settings menu — but comparing the trimmed name against
// the untrimmed stored one read as a rename into the reserved name, leaving it
// unable to save even a path-only change.
describe("a project whose stored name only differs by whitespace", () => {
  it("can still save a working directory", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSettingsDialog
        project={{ id: "p3", name: "Inbox ", repoPath: null }}
        open
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );
    await waitFor(() => expect(nameInput().value).toBe("Inbox "));
    fireEvent.change(pathInput(), { target: { value: "/code/thing" } });
    await act(async () => save());
    // Path only — the name was never really changed, so it isn't renamed (which
    // would have stranded it) and isn't rejected either.
    expect(onSave).toHaveBeenCalledWith({ repoPath: "/code/thing" });
  });
});
