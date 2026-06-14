import { startHitchDaemon, type HitchDaemonHandle } from "./daemon.js";

interface StopMessage {
  type: "stop";
}

type RunnerMessage = StopMessage;

function send(message: Record<string, unknown>): void {
  if (process.send) {
    process.send(message);
    return;
  }
  if (message.type === "log" || message.type === "error") {
    console.log(String(message.message ?? ""));
  }
}

let daemon: HitchDaemonHandle | undefined;
let stopping = false;

async function stopAndExit(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await daemon?.stop();
    send({ type: "stopped" });
    process.exit(code);
  } catch (err) {
    send({ type: "error", message: String(err) });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    daemon = await startHitchDaemon({
      cwd: process.env.HITCH_ROOT,
      configPath: process.env.HITCH_CONFIG_PATH,
      logger: {
        info: (message) => send({ type: "log", stream: "stdout", message }),
        error: (message) => send({ type: "log", stream: "stderr", message }),
      },
    });
    send({
      type: "ready",
      projectId: daemon.projectId,
      localPath: daemon.localPath,
      hitchPath: daemon.hitchPath,
      hitches: daemon.hitches.map((hitch) => ({
        projectId: hitch.projectId,
        localPath: hitch.localPath,
        hitchPath: hitch.hitchPath,
      })),
      conflicts: daemon.conflicts,
    });
  } catch (err) {
    send({ type: "error", message: String(err) });
    process.exit(1);
  }
}

process.on("message", (message: RunnerMessage) => {
  if (message?.type === "stop") void stopAndExit(0);
});

process.on("SIGINT", () => void stopAndExit(0));
process.on("SIGTERM", () => void stopAndExit(0));

void main();
