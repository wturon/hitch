import { startHitchDaemon } from "./daemon.js";

async function main(): Promise<void> {
  let daemon: Awaited<ReturnType<typeof startHitchDaemon>> | undefined;

  try {
    daemon = await startHitchDaemon();
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
