-- The organisation of each audit row written before `org_id` existed (step 18,
-- M3): by its resource, as lib/audit-log.ts's ORG_RESOURCES resolves a new
-- one, so an organisation keeps the history of its events, venues, brands and
-- members — including what members who have since left did, and what Blend'n
-- did to its data. The owner is the resource's owner today; the history of who
-- owned it before is not recorded anywhere to read. A row whose resource is no
-- organisation's (accounts, leads, categories) stays the platform's alone.
--
-- Its own transaction, after the column's: it takes row locks on the rows it
-- sets, never the table lock, so audit writes carry on while it runs. Safe to
-- re-run: it only fills rows still null. Rolling back is setting the column
-- null again (or dropping it, see the previous migration).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- resource_id is text, and not every writer put a uuid in it.
CREATE TEMP TABLE audit_org_backfill ON COMMIT DROP AS
SELECT a.id, a.resource, a.resource_id::uuid AS rid
FROM "audit_logs" a
WHERE a.org_id IS NULL
  AND a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE "audit_logs" a SET org_id = o.id
FROM audit_org_backfill b JOIN "organisations" o ON o.id = b.rid
WHERE a.id = b.id AND b.resource = 'organisation';

UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM audit_org_backfill b JOIN "events" e ON e.id = b.rid
WHERE a.id = b.id AND b.resource = 'event' AND e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = COALESCE(v.owner_org_id, v.created_by_org_id)
FROM audit_org_backfill b JOIN "venues" v ON v.id = b.rid
WHERE a.id = b.id AND b.resource = 'venue' AND COALESCE(v.owner_org_id, v.created_by_org_id) IS NOT NULL;

UPDATE "audit_logs" a SET org_id = s.org_id
FROM audit_org_backfill b JOIN "sponsors" s ON s.id = b.rid
WHERE a.id = b.id AND b.resource = 'sponsors' AND s.org_id IS NOT NULL;

-- A placement or a creative is the host's here: who acted for which side is
-- not recorded on the old rows.
UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM audit_org_backfill b JOIN "event_sponsors" p ON p.id = b.rid JOIN "events" e ON e.id = p.event_id
WHERE a.id = b.id AND b.resource = 'event_sponsors' AND e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM audit_org_backfill b
  JOIN "sponsored_creatives" c ON c.id = b.rid
  JOIN "event_sponsored_messages" m ON m.id = c.message_id
  JOIN "events" e ON e.id = m.event_id
WHERE a.id = b.id AND b.resource = 'sponsored_creatives' AND e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = COALESCE(s.org_id, e.organizer_org_id)
FROM audit_org_backfill b
  JOIN "placement_charges" ch ON ch.id = b.rid
  JOIN "event_sponsors" p ON p.id = ch.placement_id
  JOIN "events" e ON e.id = p.event_id
  JOIN "sponsors" s ON s.id = p.sponsor_id
WHERE a.id = b.id AND b.resource = 'placement_charges' AND COALESCE(s.org_id, e.organizer_org_id) IS NOT NULL;

UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM audit_org_backfill b
  JOIN "moderation_flags" f ON f.id = b.rid
  JOIN "chat_groups" g ON g.id = f.chat_group_id
  JOIN "events" e ON e.id = g.event_id
WHERE a.id = b.id AND b.resource = 'moderation_flag' AND e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM audit_org_backfill b
  JOIN "chat_polls" p ON p.id = b.rid
  JOIN "chat_messages" m ON m.id = p.message_id
  JOIN "chat_groups" g ON g.id = m.chat_group_id
  JOIN "events" e ON e.id = g.event_id
WHERE a.id = b.id AND b.resource = 'chat_polls' AND e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM audit_org_backfill b JOIN "event_feedback" f ON f.id = b.rid JOIN "events" e ON e.id = f.event_id
WHERE a.id = b.id AND b.resource = 'event_feedback' AND e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = c.org_id
FROM audit_org_backfill b JOIN "event_claims" c ON c.id = b.rid
WHERE a.id = b.id AND b.resource = 'event_claim' AND c.org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = r.org_id
FROM audit_org_backfill b JOIN "organiser_onboarding_requests" r ON r.id = b.rid
WHERE a.id = b.id AND b.resource = 'organiser_onboarding_request' AND r.org_id IS NOT NULL;

-- A room member's row names the member, not the room: the event is in its details.
UPDATE "audit_logs" a SET org_id = e.organizer_org_id
FROM "events" e
WHERE a.org_id IS NULL AND a.resource = 'chat_group_member'
  AND a.details->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND e.id = (a.details->>'eventId')::uuid AND e.organizer_org_id IS NOT NULL;

COMMIT;
