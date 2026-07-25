CREATE TYPE "public"."chat_activity" AS ENUM('working', 'idle', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."chat_block" AS ENUM('permission', 'question');--> statement-breakpoint
CREATE TYPE "public"."chat_existence" AS ENUM('running', 'dormant', 'pending');--> statement-breakpoint
CREATE TABLE "chat_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" RENAME COLUMN "cmux_ref" TO "handle";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "cwd" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "pid" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "process_started_at" bigint;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "existence" "chat_existence";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "activity" "chat_activity";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "block" "chat_block";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "last_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_events_chat_id_at_idx" ON "chat_events" USING btree ("chat_id","at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "chats_machine_harness_session_unique" ON "chats" USING btree ("machine_id","harness","session_id");