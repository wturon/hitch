import { startHitchDaemon } from "./daemon.js";
import { isServerMode } from "./v2/config.js";
import { startHitchDaemonV2 } from "./v2/daemonV2.js";

async function main(): Promise<void> {
  // V2 mode (HITCH_SERVER_URL present) runs the server-backed reconciler; the
  // V1 Convex daemon stays the default and is byte-identical otherwise.
  let daemon: { stop: () => Promise<void> } | undefined;

  try {
    daemon = isServerMode() ? await startHitchDaemonV2() : await startHitchDaemon();
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }

  async function shutdown(): Promise<void> {
    try {
      await daemon?.stop();
      process.exit(0);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
