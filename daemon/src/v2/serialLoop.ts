export interface DaemonLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

// One daemon concurrency primitive for WS-triggered work with a fallback tick:
// passes never overlap, and a trigger received mid-pass schedules one trailing
// pass so invalidations are not lost.
export class SerialLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly options: {
      intervalMs: number;
      pass: (reason: string) => Promise<void>;
      onError: (error: unknown, reason: string) => void;
    },
  ) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(
      () => this.trigger("tick"),
      this.options.intervalMs,
    );
    this.timer.unref?.();
    this.trigger("startup");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  trigger(reason: string): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.run(reason);
  }

  private async run(reason: string): Promise<void> {
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.options.pass(reason).catch((error) => {
          this.options.onError(error, reason);
        });
      } while (this.rerun && !this.stopped);
    } finally {
      this.running = false;
    }
  }
}
