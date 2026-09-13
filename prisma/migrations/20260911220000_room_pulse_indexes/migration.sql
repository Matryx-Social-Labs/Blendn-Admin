-- The room's pulse (pending flags per chat group, polled every 5s) and the
-- chatrooms list (pending flags grouped per room) filter moderation_flags on
-- (chat_group_id, status); the existing index leads on chat_group_id alone and
-- applied status as a filter over every flag the room ever had.
CREATE INDEX "moderation_flags_chat_group_id_status_idx" ON "moderation_flags"("chat_group_id", "status");

-- getOccupancies: open sessions per event. Neither existing presence_sessions
-- index leads on (event_id, departed_at).
CREATE INDEX "presence_sessions_event_id_departed_at_idx" ON "presence_sessions"("event_id", "departed_at");

-- The rooms list: published events that ended less than 24h ago. The
-- (status, start_time) index matches every event that has ever started;
-- end_time is the selective bound.
CREATE INDEX "events_status_end_time_idx" ON "events"("status", "end_time");
