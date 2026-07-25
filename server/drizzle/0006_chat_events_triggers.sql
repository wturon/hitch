-- Custom migration: NOTIFY trigger for chat_events (mirrors chats_notify_change
-- in 0001_triggers.sql). Realtime is table-granular — see docs/v2-prd.md
-- "Realtime" and desktop/src/renderer/lib/server/queryKeys.ts, where
-- chat_events maps onto the coarse ["chats"] query key.
--
-- No chat_events_set_updated_at: the table has no updated_at column. Rows are
-- relayed hook events — immutable once landed, stamped with the producer's
-- `at` and the server's created_at.

CREATE TRIGGER chat_events_notify_change AFTER INSERT OR UPDATE OR DELETE ON "chat_events" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();
