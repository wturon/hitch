-- Custom migration: updated_at + NOTIFY triggers (see docs/v2-prd.md "Realtime").
--
-- hitch_set_updated_at: BEFORE UPDATE on every table with an updated_at column.
-- hitch_notify_change: AFTER INSERT/UPDATE/DELETE on every table — emits
--   pg_notify('hitch_changes', '{"table": <name>, "id": <row id>}').
-- hitch_notify_task_tags_change: task_tags has a composite PK, so its payload
--   carries the composite fields instead of an "id".

CREATE FUNCTION hitch_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE FUNCTION hitch_notify_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('hitch_changes', json_build_object('table', TG_TABLE_NAME, 'id', OLD.id)::text);
  ELSE
    PERFORM pg_notify('hitch_changes', json_build_object('table', TG_TABLE_NAME, 'id', NEW.id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE FUNCTION hitch_notify_task_tags_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('hitch_changes', json_build_object('table', TG_TABLE_NAME, 'task_id', OLD.task_id, 'tag_id', OLD.tag_id)::text);
  ELSE
    PERFORM pg_notify('hitch_changes', json_build_object('table', TG_TABLE_NAME, 'task_id', NEW.task_id, 'tag_id', NEW.tag_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- projects
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON "projects" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER projects_notify_change AFTER INSERT OR UPDATE OR DELETE ON "projects" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- sections
CREATE TRIGGER sections_set_updated_at BEFORE UPDATE ON "sections" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER sections_notify_change AFTER INSERT OR UPDATE OR DELETE ON "sections" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- tasks
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON "tasks" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER tasks_notify_change AFTER INSERT OR UPDATE OR DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- tags
CREATE TRIGGER tags_set_updated_at BEFORE UPDATE ON "tags" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER tags_notify_change AFTER INSERT OR UPDATE OR DELETE ON "tags" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- task_tags (no updated_at column; composite-PK notify payload)
CREATE TRIGGER task_tags_notify_change AFTER INSERT OR UPDATE OR DELETE ON "task_tags" FOR EACH ROW EXECUTE FUNCTION hitch_notify_task_tags_change();--> statement-breakpoint

-- comments
CREATE TRIGGER comments_set_updated_at BEFORE UPDATE ON "comments" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER comments_notify_change AFTER INSERT OR UPDATE OR DELETE ON "comments" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- attachments
CREATE TRIGGER attachments_set_updated_at BEFORE UPDATE ON "attachments" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER attachments_notify_change AFTER INSERT OR UPDATE OR DELETE ON "attachments" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- machines
CREATE TRIGGER machines_set_updated_at BEFORE UPDATE ON "machines" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER machines_notify_change AFTER INSERT OR UPDATE OR DELETE ON "machines" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- chats
CREATE TRIGGER chats_set_updated_at BEFORE UPDATE ON "chats" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER chats_notify_change AFTER INSERT OR UPDATE OR DELETE ON "chats" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();--> statement-breakpoint

-- assignments
CREATE TRIGGER assignments_set_updated_at BEFORE UPDATE ON "assignments" FOR EACH ROW EXECUTE FUNCTION hitch_set_updated_at();--> statement-breakpoint
CREATE TRIGGER assignments_notify_change AFTER INSERT OR UPDATE OR DELETE ON "assignments" FOR EACH ROW EXECUTE FUNCTION hitch_notify_change();
