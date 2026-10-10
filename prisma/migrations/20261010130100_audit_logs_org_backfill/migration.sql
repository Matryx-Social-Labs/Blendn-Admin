-- The organisation of each audit row written before `org_id` existed (step 18,
-- M3), as of WHEN THE ROW WAS WRITTEN — never by who owns its resource today.
-- A venue or a brand that changed hands takes none of its previous owner's
-- history with it, and money is its payer's:
--
--   - organisation, event claim, application: the organisation they name,
--     which never changes;
--   - event (and its room's flags, polls, feedback and members): its host, for
--     a row written while that host held it — since its claim, or ever if it
--     was never claimed; before a claim, nobody's;
--   - venue, brand: their owner, for a row written since that owner's claim,
--     or ever if the record was never claimed; before, nobody's;
--   - a venue's or a brand's claim: the claimant (`details.orgId`);
--   - billing and entitlements on a venue: the payer, as the row recorded it
--     (`details.orgId`), else nobody's;
--   - a placement charge: the brand's owner, if it owned the brand then;
--   - a placement or a creative: nobody's (which side acted is not recorded).
--
-- "Nobody's" is NULL: the platform's alone, never read by an organisation.
-- Staging held 597 rows on 2026-10-10, so one statement per kind, unbatched.
--
-- Its own transaction, after the column's, with row locks only. Safe to
-- re-run: it only fills rows still null. Rolling back is setting the column
-- null again (or dropping it, see the previous migration).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- resource_id is text, and not every writer put a uuid in it: a user's id is
-- not one, and a room member's row names the member. Cast only what is one.
CREATE TEMP TABLE audit_org_backfill ON COMMIT DROP AS
SELECT a.id, a.resource, a.action, a.created_at,
       CASE WHEN a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN a.resource_id::uuid END AS rid,
       CASE WHEN a.details->>'orgId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (a.details->>'orgId')::uuid END AS detail_org,
       CASE WHEN a.details->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (a.details->>'eventId')::uuid END AS detail_event
FROM "audit_logs" a
WHERE a.org_id IS NULL
  AND (a.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR a.resource = 'chat_group_member');

-- An event's host at a moment: the host it has, if it had it then.
CREATE TEMP TABLE audit_event_host ON COMMIT DROP AS
SELECT e.id, e.organizer_org_id AS org, e.claimed_at FROM "events" e WHERE e.organizer_org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = o.id
FROM audit_org_backfill b JOIN "organisations" o ON o.id = b.rid
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'organisation';

UPDATE "audit_logs" a SET org_id = c.org_id
FROM audit_org_backfill b JOIN "event_claims" c ON c.id = b.rid
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'event_claim' AND c.org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = r.org_id
FROM audit_org_backfill b JOIN "organiser_onboarding_requests" r ON r.id = b.rid
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'organiser_onboarding_request' AND r.org_id IS NOT NULL;

UPDATE "audit_logs" a SET org_id = h.org
FROM audit_org_backfill b JOIN audit_event_host h ON h.id = b.rid
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'event' AND (h.claimed_at IS NULL OR b.created_at >= h.claimed_at);

UPDATE "audit_logs" a SET org_id = h.org
FROM audit_org_backfill b
  JOIN "moderation_flags" f ON f.id = b.rid
  JOIN "chat_groups" g ON g.id = f.chat_group_id
  JOIN audit_event_host h ON h.id = g.event_id
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'moderation_flag' AND (h.claimed_at IS NULL OR b.created_at >= h.claimed_at);

UPDATE "audit_logs" a SET org_id = h.org
FROM audit_org_backfill b
  JOIN "chat_polls" p ON p.id = b.rid
  JOIN "chat_messages" m ON m.id = p.message_id
  JOIN "chat_groups" g ON g.id = m.chat_group_id
  JOIN audit_event_host h ON h.id = g.event_id
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'chat_polls' AND (h.claimed_at IS NULL OR b.created_at >= h.claimed_at);

UPDATE "audit_logs" a SET org_id = h.org
FROM audit_org_backfill b JOIN "event_feedback" f ON f.id = b.rid JOIN audit_event_host h ON h.id = f.event_id
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'event_feedback' AND (h.claimed_at IS NULL OR b.created_at >= h.claimed_at);

UPDATE "audit_logs" a SET org_id = h.org
FROM audit_org_backfill b JOIN audit_event_host h ON h.id = b.detail_event
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'chat_group_member' AND (h.claimed_at IS NULL OR b.created_at >= h.claimed_at);

-- Claims, billing and entitlements on a venue or a brand: the organisation the
-- row itself recorded (the claimant, the payer, the grantee), and no other.
UPDATE "audit_logs" a SET org_id = b.detail_org
FROM audit_org_backfill b
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource IN ('venue', 'sponsors') AND b.detail_org IS NOT NULL
  AND (b.action LIKE 'venue.claim.%' OR b.action LIKE 'sponsor.claim.%' OR b.action LIKE 'billing.%' OR b.action LIKE 'entitlement.%');

-- Everything else on a venue or a brand: its owner, for a row written since
-- that owner had it — never a claim's, a payer's or an entitlement's row.
UPDATE "audit_logs" a SET org_id = COALESCE(v.owner_org_id, v.created_by_org_id)
FROM audit_org_backfill b JOIN "venues" v ON v.id = b.rid
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'venue'
  AND b.action NOT LIKE 'venue.claim.%' AND b.action NOT LIKE 'billing.%' AND b.action NOT LIKE 'entitlement.%'
  AND COALESCE(v.owner_org_id, v.created_by_org_id) IS NOT NULL
  AND (v.claimed_at IS NULL OR b.created_at >= v.claimed_at);

UPDATE "audit_logs" a SET org_id = s.org_id
FROM audit_org_backfill b JOIN "sponsors" s ON s.id = b.rid
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'sponsors'
  AND b.action NOT LIKE 'sponsor.claim.%'
  AND s.org_id IS NOT NULL AND (s.claimed_at IS NULL OR b.created_at >= s.claimed_at);

-- A charge is the brand's, if the brand's owner had it when the row was written.
UPDATE "audit_logs" a SET org_id = s.org_id
FROM audit_org_backfill b
  JOIN "placement_charges" ch ON ch.id = b.rid
  JOIN "event_sponsors" p ON p.id = ch.placement_id
  JOIN "sponsors" s ON s.id = p.sponsor_id
WHERE a.org_id IS NULL AND a.id = b.id AND b.resource = 'placement_charges'
  AND s.org_id IS NOT NULL AND (s.claimed_at IS NULL OR b.created_at >= s.claimed_at);

COMMIT;
