ALTER TABLE "machines" ADD COLUMN "chat_snapshot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "chat_window_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "chat_window_cap" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "chat_window_truncated" boolean;