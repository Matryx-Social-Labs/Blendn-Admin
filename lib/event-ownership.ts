import type { user_role } from "@prisma/client"

import { db } from "./db"
import { canCreateEvents } from "./rbac"
import { activeMembership } from "./org-membership"

/**
 * Which organisation owns an event.
 *
 * `events.organizer_org_id` is the column `lib/rbac.ts` is built on, and until
 * now **nothing in production wrote it**. The only assignments in the repo were
 * two seed scripts. So every event created through the product had it null,
 * `eventPermissions` could never match the organiser branch, and an organiser
 * could not edit the event they had just created.
 *
 * `GET /api/events` survived only because of a legacy `organizer_id` clause
 * described in the code as being "kept so an event created before organisations
 * existed stays visible to its creator". That shim was load-bearing for every
 * event in the database.
 *
 * ## Why the ordering matters
 *
 * `lib/venue-actions.ts` resolves a creator's org with `findFirst` and no
 * `orderBy`. With more than one membership Postgres may return either row, so
 * two saves by the same person can pick different organisations — and which one
 * they get decides who else can edit the thing. Oldest membership wins here:
 * deterministic, and the one somebody would call their home org.
 *
 * The same rule is used by the backfill migration, so a row written today and a
 * row backfilled from before it land on the same organisation.
 *
 * ## Why admin returns null rather than throwing
 *
 * `eventPermissions` short-circuits `app_admin` before it looks at ownership,
 * so a platform-created event needs no org to be operable.
 *
 * This note used to say that curation would turn null into a platform org. It
 * does not, and the reason is worth keeping: `events.curated_at` carries
 * "the platform added this" as an assertion, so ownership does not have to
 * carry it as an absence. A platform org would have bought nothing except a row
 * that every permission check then has to special-case — and null already
 * means three things without it.
 */
/**
 * The one organisation a person acts for when nothing says which: the oldest
 * live membership, or null (SCRUM-148).
 *
 * Every picker of "my org" goes through this — event creation, venue creation,
 * venue claims — so a person in two organisations lands on the same one from
 * every form. Two of those pickers used to do their own `findFirst` with no
 * `orderBy`, which on a second membership is whichever row Postgres felt like.
 * An org picker on the forms is the day somebody has two; until then the rule
 * is stated on the org page.
 */
export async function homeOrgIdFor(user: { id: string; role: user_role }): Promise<string | null> {
  if (user.role === "app_admin") return null
  const membership = await db.organisation_members.findFirst({
    where: { user_id: user.id, ...activeMembership },
    orderBy: { created_at: "asc" },
    select: { org_id: true },
  })
  return membership?.org_id ?? null
}

export async function owningOrgFor(user: {
  id: string
  role: user_role
}): Promise<string | null> {
  if (user.role === "app_admin") return null

  const orgId = await homeOrgIdFor(user)

  if (!orgId) {
    /*
     * Loud, not null.
     *
     * Writing null here is what the product did for its whole life, and the
     * symptom was silent: the event saved, appeared in the list, and then
     * refused its own creator at the edit screen. A creator with no
     * organisation is a broken onboarding, and it should say so at the moment
     * it happens rather than three clicks later.
     */
    throw new Error(
      "Your account is not attached to an organisation yet, so this event would have no owner. Ask an admin to add you to one."
    )
  }

  return orgId
}

/**
 * Whether to offer this person "Create event" at all (SCRUM-145).
 *
 * The role allows it, and — for anyone but an admin — there is a live home
 * organisation for the event to belong to: exactly what `owningOrgFor` will
 * insist on at save. An organiser in no organisation, or only in a suspended
 * one, was offered the whole form and refused at the end of it.
 */
export async function mayCreateEvents(user: { id: string; role: user_role }): Promise<boolean> {
  if (!canCreateEvents(user.role)) return false
  if (user.role === "app_admin") return true
  return (await homeOrgIdFor(user)) !== null
}
