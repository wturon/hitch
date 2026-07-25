import { cn } from "@/lib/utils";
import type { ChatActivity, ChatBlock, ChatExistence, ChatStatus } from "./model";

// The mark vocabulary. An instrument is scanned, not read, so every state is
// encoded TWICE — in shape and in color — and never in color alone. The
// semantic ramp lives in styles.css under `.hitch-inspector` and is built
// entirely out of the app's existing tag tints, so this introduces no palette:
// blue = the machine is doing something, amber = it wants you, neutral = at
// rest, red = the instrument itself is not to be trusted.

type Tone = "busy" | "wait" | "idle" | "dead" | "alarm";

const TONE_TEXT: Record<Tone, string> = {
  busy: "text-[var(--ins-busy)]",
  wait: "text-[var(--ins-wait)]",
  idle: "text-[var(--ins-idle)]",
  dead: "text-[var(--ins-dead)]",
  alarm: "text-[var(--ins-alarm)]",
};

const TONE_BG: Record<Tone, string> = {
  busy: "bg-[var(--ins-busy-bg)]",
  wait: "bg-[var(--ins-wait-bg)]",
  idle: "bg-[var(--ins-idle-bg)]",
  dead: "bg-transparent",
  alarm: "bg-[var(--ins-alarm-bg)]",
};

const STATUS_TONE: Record<ChatStatus, Tone> = {
  busy: "busy",
  waiting_input: "wait",
  idle: "idle",
  dead: "dead",
};

const STATUS_LABEL: Record<ChatStatus, string> = {
  busy: "busy",
  waiting_input: "waiting",
  idle: "idle",
  dead: "dead",
};

/**
 * The status conclusion. Four distinct SHAPES, so the column reads without
 * color at all: filled disc (busy), ringed disc (waiting — the only state
 * that wants a human), hollow ring (idle), hairline dash (dead).
 */
export function StatusMark({ status }: { status: ChatStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={cn("flex items-center gap-1.5", TONE_TEXT[tone])}>
      <span aria-hidden className="relative flex size-2.5 shrink-0 items-center justify-center">
        {status === "busy" && <span className="size-2 rounded-full bg-current" />}
        {status === "waiting_input" && (
          <>
            <span className="absolute inset-0 rounded-full border border-current opacity-45" />
            <span className="size-1.5 rounded-full bg-current" />
          </>
        )}
        {status === "idle" && <span className="size-2 rounded-full border border-current" />}
        {status === "dead" && <span className="h-px w-2.5 bg-current" />}
      </span>
      <span className="text-[12px] leading-none">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/**
 * Existence — owned by the machine's process table. Shape carries it: filled
 * (a live process), hollow (a transcript inside the window, no process),
 * dashed (launched, not yet bound), and a bare em-dash for absent, which is
 * the one value the server writes rather than the daemon (absence = dead).
 */
export function ExistenceMark({ value }: { value: ChatExistence | null }) {
  if (value === null) return <AxisEmpty label="absent" />;
  return (
    <span className="flex items-center gap-1.5 text-[12px] leading-none text-foreground">
      <span aria-hidden className="flex size-2.5 shrink-0 items-center justify-center">
        {value === "running" && <span className="size-2 rounded-full bg-[var(--ins-busy)]" />}
        {value === "dormant" && (
          <span className="size-2 rounded-full border border-[var(--ins-idle)]" />
        )}
        {value === "pending" && (
          <span className="size-2 rounded-full border border-dashed border-[var(--ins-busy)]" />
        )}
      </span>
      {value}
    </span>
  );
}

/**
 * Activity — also machine-owned. `unknown` is deliberately NOT alarming: the
 * status function resolves it to idle on the principle that idle beats
 * guessing working, and the mark should say the same thing.
 */
export function ActivityMark({ value }: { value: ChatActivity | null }) {
  if (value === null) return <AxisEmpty label="—" />;
  const working = value === "working";
  return (
    <span
      className={cn(
        "text-[12px] leading-none",
        working ? "font-medium text-[var(--ins-busy)]" : "text-muted-foreground",
        value === "unknown" && "italic",
      )}
    >
      {value}
    </span>
  );
}

/**
 * Block — the ONLY axis hooks own, and the only one that means "a human is
 * needed". Rendered as a filled pill so it is the loudest thing in the row
 * group; absent is a faint dash, because "not blocked" is the normal case.
 */
export function BlockMark({ value }: { value: ChatBlock | null }) {
  if (value === null) return <AxisEmpty label="—" />;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium leading-[14px]",
        TONE_BG.wait,
        TONE_TEXT.wait,
      )}
    >
      {value}
    </span>
  );
}

function AxisEmpty({ label }: { label: string }) {
  return <span className="text-[12px] leading-none text-[var(--ins-dead)]">{label}</span>;
}

/** A neutral chip for harness / attachment / handle — chrome, never a state. */
export function Chip({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-[5px] bg-muted px-1.5 py-0.5 text-[11px] leading-[14px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The health strip's alarm treatment — reused for stale AND partial coverage. */
export function AlarmChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium leading-[14px]",
        TONE_BG.alarm,
        TONE_TEXT.alarm,
      )}
    >
      {children}
    </span>
  );
}
