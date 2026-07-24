import { startHitchDaemonV2 } from "./v2/daemonV2.js";

async function main(): Promise<void> {
  // V2 is the only daemon now: a pure reconciler against the Hono server.
  let daemon: { stop: () => Promise<void> } | undefined;

  try {
    daemon = await startHitchDaemonV2();
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
