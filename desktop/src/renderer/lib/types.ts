import type { Id } from "@convex/_generated/dataModel";
import type { ProjectStatus } from "@/lib/projectConfig";

// One project as it appears in the app rail: the project itself, the viewer's
// membership (null while a just-created project's membership is still syncing),
// and pin state. Shared between App's board state and the sidebar components.
export interface ProjectNavEntry {
  project: {
    _id: Id<"projects">;
    name: string;
    statuses?: ProjectStatus[];
  };
  membership: {
    role: "owner" | "member";
  } | null;
  pinned: boolean;
  pinnedOrder: number | null;
}

// The signed-in user, as surfaced in the account footer.
export interface Viewer {
  name: string | null;
  email: string | null;
  image: string | null;
}

// Keep-awake (caffeinate) state reported by the desktop bridge.
export interface KeepAwakeState {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  error: string | null;
}
