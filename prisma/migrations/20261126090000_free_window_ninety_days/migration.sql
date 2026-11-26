-- SCRUM-1269: the free window is 90 days, not 30 (DECISIONS 2026-11-25;
-- FREE_WINDOW_DAYS in lib/analytics-access.ts). Every window already written
-- moves by the 60 days, so a host counted under the old rule gets the same
-- three months as one counted under the new.
--
-- Data only, no DDL. first_free_event_id is left as written, even where that
-- night had 5-7 people (the new floor is 8): the window is written once, by
-- design. Staging on 2026-11-26: 2 rows, none with a 5-7 first night.
UPDATE organisations
   SET analytics_free_until = analytics_free_until + interval '60 days'
 WHERE analytics_free_until IS NOT NULL;
