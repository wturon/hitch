import { startHitchDaemonV2, type HitchDaemonV2Handle } from "./v2/daemonV2.js";

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

let daemonV2: HitchDaemonV2Handle | undefined;
let stopping = false;

async function stopAndExit(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await daemonV2?.stop();
    send({ type: "stopped" });
    process.exit(code);
  } catch (err) {
    send({ type: "error", message: String(err) });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // V2 is the only daemon now: a pure reconciler against the Hono server.
  try {
    daemonV2 = await startHitchDaemonV2({
      cwd: process.env.HITCH_ROOT,
      logger: {
        info: (message) => send({ type: "log", stream: "stdout", message }),
        error: (message) => send({ type: "log", stream: "stderr", message }),
      },
    });
    send({ type: "ready", mode: "v2", machineId: daemonV2.machineId });
  } catch (err) {
    send({ type: "error", message: String(err) });
    process.exit(1);
  }
}

process.on("message", (message: RunnerMessage) => {
  if (message?.type === "stop") {
    void stopAndExit(0);
  }
});

process.on("SIGINT", () => void stopAndExit(0));
process.on("SIGTERM", () => void stopAndExit(0));

void main();
