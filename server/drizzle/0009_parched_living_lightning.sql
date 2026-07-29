CREATE TYPE "public"."task_auto_title_state" AS ENUM('pending', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_title_state" "task_auto_title_state";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_title_seed" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_title_claimed_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_title_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_title_error" text;--> statement-breakpoint
CREATE INDEX "tasks_auto_title_state_idx" ON "tasks" USING btree ("auto_title_state");