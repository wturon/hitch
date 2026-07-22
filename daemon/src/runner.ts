import { startHitchDaemon, type HitchDaemonHandle } from "./daemon.js";
import { isServerMode } from "./v2/config.js";
import { startHitchDaemonV2, type HitchDaemonV2Handle } from "./v2/daemonV2.js";

interface StopMessage {
  type: "stop";
}

// A request/response call into the daemon's debug API, correlated by `id`. The
// desktop main process forwards these from the renderer's debug screen and
// awaits the matching debug-response.
interface DebugRequestMessage {
  type: "debug-request";
  id: string;
  op: "listCmuxChats" | "reconcileCmux" | "readCmuxTrace";
  projectId?: string | null;
  filter?: { chatId?: string | null; launchId?: string | null };
  limit?: number;
}

type RunnerMessage = StopMessage | DebugRequestMessage;

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
let daemonV2: HitchDaemonV2Handle | undefined;
let stopping = false;

async function stopAndExit(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await (daemon ?? daemonV2)?.stop();
    send({ type: "stopped" });
    process.exit(code);
  } catch (err) {
    send({ type: "error", message: String(err) });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // V2 mode (HITCH_SERVER_URL present): start the server-backed daemon instead
  // of the V1 Convex daemon. The V1 branch below is byte-identical otherwise.
  if (isServerMode()) {
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
    return;
  }
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

async function handleDebugRequest(message: DebugRequestMessage): Promise<void> {
  const reply = (payload: Record<string, unknown>) =>
    send({ type: "debug-response", id: message.id, ...payload });
  try {
    const debug = daemon?.debug;
    if (!debug) {
      reply({ ok: false, error: "debug api unavailable" });
      return;
    }
    if (message.op === "listCmuxChats") {
      reply({ ok: true, data: debug.listCmuxChats(message.projectId ?? null) });
    } else if (message.op === "reconcileCmux") {
      reply({ ok: true, data: await debug.reconcileCmux(message.projectId ?? null) });
    } else if (message.op === "readCmuxTrace") {
      reply({
        ok: true,
        data: debug.readCmuxTrace(message.filter ?? {}, message.limit),
      });
    } else {
      reply({ ok: false, error: `unknown debug op` });
    }
  } catch (err) {
    reply({ ok: false, error: String(err) });
  }
}

process.on("message", (message: RunnerMessage) => {
  if (message?.type === "stop") {
    void stopAndExit(0);
  } else if (message?.type === "debug-request") {
    void handleDebugRequest(message);
  }
});

process.on("SIGINT", () => void stopAndExit(0));
process.on("SIGTERM", () => void stopAndExit(0));

void main();
