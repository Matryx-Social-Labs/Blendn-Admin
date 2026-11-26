import { $Enums, Prisma, type org_role, type user_role } from "@prisma/client"

// Relative: reachable from server.ts via socket-ops-auth. See v0.12.1.
import { db } from "./db"
import { isUuid } from "./api-input"
import type { PermissionActor, SponsorGrant } from "./rbac"

/**
 * The membership filter every read must use: memberships of organisations
 * that are not suspended.
 *
 * Suspending an organisation used to change a badge and nothing else
 * (SCRUM-8): `actorFor` loaded memberships with no reference to org status,
 * so members kept every permission. This fragment is what suspension
 * *means* on the dashboard side, and it is spread into every membership read
 * outside this module — `__tests__/membership-reads-are-scoped.test.ts` fails
 * the build on one that does not. `getMyOrgs` is the documented exception:
 * it lists suspended orgs so the org page can say why the controls are gone.
 *
 * `status` is a non-null enum, so `not` is safe here; the NULL trap
 * (`prisma-not-excludes-null`) is on nullable columns.
 */
export const activeMembership = { org: { status: { not: "suspended" as const } } }

/**
 * Which membership is someone's home: the oldest, and on an identical
 * `created_at` (two rows written in one transaction, or by a seed) the lower
 * `org_id`. Without the second key Postgres may return either, so two saves
 * could file under two organisations and the sidebar could name a third.
 * `homeOrgIdFor` and `activeOrgsFor` both order by this.
 */
export const HOME_ORG_ORDER = [{ created_at: "asc" as const }, { org_id: "asc" as const }]

/**
 * An organisation's dashboard kind, over the alias `o`. A brand's (granted `may_sponsor`, or owning a live, unmerged
 * brand: a revoked grant still leaves a brand to look after) before a venue's (owns a live venue), a venue's before an
 * events org's. An org that has neither yet is what its approved application asked to be: a venue owner approved this
 * morning has no venue until their first claim, and must be able to file it. SQL, not TypeScript, so the session read is
 * one statement; this is the rule's only text.
 */
export const ORG_KIND_SQL = Prisma.sql`CASE
  WHEN o.may_sponsor OR EXISTS (SELECT 1 FROM sponsors s WHERE s.org_id = o.id AND s.deleted_at IS NULL AND s.merged_into IS NULL) THEN 'sponsor'
  WHEN EXISTS (SELECT 1 FROM venues v WHERE v.owner_org_id = o.id AND v.deleted_at IS NULL) THEN 'venue_owner'
  WHEN EXISTS (SELECT 1 FROM organiser_onboarding_requests r WHERE r.org_id = o.id AND r.status = 'approved' AND r.requested_role = 'sponsor') THEN 'sponsor'
  WHEN EXISTS (SELECT 1 FROM organiser_onboarding_requests r WHERE r.org_id = o.id AND r.status = 'approved' AND r.requested_role = 'venue_owner') THEN 'venue_owner'
  ELSE 'organizer'
END`

/** The kind of the home organisation of the user aliased `u`: `activeMembership` and `HOME_ORG_ORDER`, in SQL. NULL with none. */
const HOME_KIND_SQL = Prisma.sql`(
  SELECT ${ORG_KIND_SQL}
  FROM organisation_members m JOIN organisations o ON o.id = m.org_id
  WHERE m.user_id = u.id AND o.status <> 'suspended'
  ORDER BY m.created_at ASC, m.org_id ASC
  LIMIT 1
)`

const HOST_KINDS: readonly user_role[] = ["sponsor", "venue_owner", "organizer"]

/**
 * Who someone is to the dashboard (SCRUM-1247): `app_admin` if the row is, whatever their memberships; otherwise the kind
 * of their home organisation (the oldest live membership; a suspended org grants nothing); with none, `attendee`.
 * `User.role` is read only for the admin check, so task 11 can stop writing it for hosts. Someone in orgs of two kinds
 * sees their home org's dashboard (a mixed nav is design's, BACKLOG). Anything else from the query is a refusal.
 */
export function dashboardRoleFor(row: { role: user_role; home_kind: string | null }): user_role {
  if (row.role === "app_admin") return "app_admin"
  if (row.home_kind === null) return "attendee"
  const kind = HOST_KINDS.find((k) => k === row.home_kind)
  if (!kind) throw new Error("Unknown organisation kind")
  return kind
}

const USER_ROLES = new Set<string>(Object.values($Enums.user_role))

/** What the session readers need of a person: the row's `role` (for `isRevoked`'s admin rule) and `dashboardRole`. */
export interface SessionAccount {
  id: string
  email: string
  name: string | null
  role: user_role
  suspended_at: Date | null
  deletedAt: Date | null
  password_changed_at: Date | null
  sessions_revoked_at: Date | null
  dashboardRole: user_role
}

type Row = Omit<SessionAccount, "dashboardRole" | "role"> & { role: string; home_kind: string | null }

function toAccount({ home_kind, ...row }: Row): SessionAccount {
  if (!USER_ROLES.has(row.role)) throw new Error("Unknown user role")
  const role = row.role as user_role
  return { ...row, role, dashboardRole: dashboardRoleFor({ role, home_kind }) }
}

const ACCOUNT_COLUMNS = Prisma.sql`u.id, u.email, u.name, u.role::text AS role, u.suspended_at, u."deletedAt",
  u.password_changed_at, u.sessions_revoked_at, ${HOME_KIND_SQL} AS home_kind`

/**
 * The one read every dashboard session makes (the jwt callback, `currentUser`, the socket handshake): the account and
 * its dashboard role in ONE statement. A Prisma nested select is one call but three round trips, on every request.
 */
export async function sessionAccount(id: string): Promise<SessionAccount | null> {
  const [row] = await db.$queryRaw<Row[]>`SELECT ${ACCOUNT_COLUMNS} FROM "User" u WHERE u.id = ${id}`
  return row ? toAccount(row) : null
}

/** `sessionAccount` for sign-in alone: by address, with the password hash. */
export async function signinAccount(email: string): Promise<(SessionAccount & { password: string | null }) | null> {
  const [row] = await db.$queryRaw<(Row & { password: string | null })[]>`SELECT ${ACCOUNT_COLUMNS}, u.password FROM "User" u WHERE u.email = ${email}`
  return row ? { ...toAccount(row), password: row.password } : null
}

/** Which of this person's organisations are suspended, for the banner. */
export async function suspendedOrgsFor(
  userId: string
): Promise<{ id: string; display_name: string; reason: string | null }[]> {
  const rows = await db.organisation_members.findMany({
    where: { user_id: userId, org: { status: "suspended" } },
    select: { org: { select: { id: true, display_name: true, suspension_reason: true } } },
    orderBy: { created_at: "asc" },
  })
  return rows.map((r) => ({ id: r.org.id, display_name: r.org.display_name, reason: r.org.suspension_reason }))
}

/**
 * This person's live organisations, oldest membership first, for the sidebar's
 * identity card.
 *
 * Oldest first because that is `homeOrgIdFor`'s rule: the first one is the
 * organisation a new event is created under, so it is the one the card names.
 * There is no "current organisation" to switch between — every read is scoped
 * to the union of these (`actorFor`) — so the card names the home one and
 * counts the rest rather than offering a switcher that would change nothing.
 */
export async function activeOrgsFor(
  userId: string
): Promise<{ id: string; display_name: string; role: org_role }[]> {
  const rows = await db.organisation_members.findMany({
    where: { user_id: userId, ...activeMembership },
    select: { role: true, org: { select: { id: true, display_name: true } } },
    orderBy: HOME_ORG_ORDER,
  })
  return rows.map((r) => ({ ...r.org, role: r.role }))
}

/**
 * Load an actor with the organisations they belong to.
 *
 * `eventPermissions` is pure and takes memberships as data, so every call site
 * has to supply them. This is the one place that reads them, which keeps the
 * query identical everywhere — a route that fetched memberships slightly
 * differently would produce a different answer to the same authorization
 * question.
 *
 * Admins short-circuit: they bypass org checks entirely, so loading their
 * memberships would be a query whose result is never read.
 */
export async function actorFor(user: {
  id: string
  role: user_role
}): Promise<PermissionActor> {
  /*
   * The role the database holds now, not the one the caller passed (step 18).
   * Callers hand in a session's user, whose role is a claim; the admin
   * short-circuit below grants everything, so it is decided on the row. A
   * deleted or suspended account is nobody: no role worth the name, no orgs.
   */
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { role: true, suspended_at: true, deletedAt: true },
  })
  if (!row || row.deletedAt || row.suspended_at) return { id: user.id, role: "attendee", orgIds: [], editOrgIds: [] }
  if (row.role === "app_admin") return { id: user.id, role: row.role, orgIds: [], editOrgIds: [] }

  const memberships = await db.organisation_members.findMany({
    where: { user_id: user.id, ...activeMembership },
    select: { org_id: true, role: true },
  })

  return {
    id: user.id,
    role: row.role,
    orgIds: memberships.map((m) => m.org_id),
    // Owner and admin edit; `staff` operates only (SCRUM-1244, `orgPermissions` already gives staff nothing).
    editOrgIds: memberships.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.org_id),
  }
}

/**
 * Whether any organisation this actor belongs to may sell placement.
 *
 * A separate query rather than a field on `PermissionActor`, because the flag
 * is only ever needed on the one route that writes a sponsored message —
 * loading it for every permission check would put a join on the hot path of
 * every event read to answer a question almost nobody asks.
 *
 * `app_admin` short-circuits to true and never queries: `actorFor` gives them
 * an empty `orgIds`, so the `some` below would be vacuously false and an admin
 * would be refused their own platform's placement.
 */

/**
 * Resolve the ONE organisation acting, with both of its entitlements together.
 *
 * ## The bug this exists to make unrepresentable
 *
 * `maySponsorFor` above answers "does **any** org you belong to hold the flag".
 * A `placesAtEvent` written the same way answers "does **any** org you belong to
 * have a placement". Pass both to `canBroadcast` as separate booleans and a
 * person who is staff at Org A (flag, no placement) and Org B (placement, no
 * flag) satisfies the check while neither organisation is entitled to send.
 *
 * One query, one row, both fields. There is no arrangement of the result that
 * mixes two organisations.
 *
 * Returns `null` when no org of this actor's both holds the flag and has an
 * approved placement here — which `canBroadcast` treats as a refusal.
 *
 * `sponsorId` narrows it to one brand: the organisation must own that brand,
 * and that brand must hold the placement. Pass it whenever the thing being
 * changed already belongs to a brand — a campaign. Without it, any brand
 * placed at the event satisfies the grant, and each could edit the others'
 * campaigns there (SCRUM-319).
 *
 * `app_admin` deliberately gets no grant: `canBroadcast` short-circuits them
 * before this is consulted, and manufacturing a synthetic org id for them would
 * put a lie in the audit trail.
 */
export async function resolveSponsorGrant(
  actor: { role: user_role; orgIds: string[] },
  eventId: string,
  sponsorId?: string | null
): Promise<SponsorGrant | null> {
  if (actor.role === "app_admin") return null
  if (actor.orgIds.length === 0) return null
  // A server action passes this through as the client sent it; an object would
  // be a filter, and "an approved placement at ANY event" is not a grant.
  if (!isUuid(eventId)) return null
  // A campaign with no brand belongs to no organisation that could hold a grant.
  if (sponsorId === null) return null

  const org = await db.organisations.findFirst({
    where: {
      id: { in: actor.orgIds },
      may_sponsor: true,
      // The SAME organisation must also hold the placement. Expressed as a
      // relation filter rather than a second query precisely so the two facts
      // cannot come from two different rows.
      sponsors: {
        some: {
          ...(sponsorId ? { id: sponsorId } : {}),
          deleted_at: null,
          merged_into: null,
          placements: { some: { event_id: eventId, status: "approved" } },
        },
      },
    },
    select: { id: true },
  })

  if (!org) return null
  return { orgId: org.id, maySponsor: true, placesAtEvent: true }
}

/**
 * Which of these events this actor's orgs place at, in one query.
 *
 * `resolveSponsorGrant` is correct for one event and wrong in a loop — a
 * sponsor dashboard listing forty placements would issue forty queries. This is
 * the list-context answer; it deliberately does NOT return a grant, because a
 * grant is an authorization decision about one event and this is a filter.
 */
export async function placesAtEventBulk(
  actor: { role: user_role; orgIds: string[] },
  eventIds: string[]
): Promise<Set<string>> {
  if (actor.orgIds.length === 0 || eventIds.length === 0) return new Set()

  const rows = await db.event_sponsors.findMany({
    where: {
      event_id: { in: eventIds },
      status: "approved",
      sponsor: { org_id: { in: actor.orgIds }, deleted_at: null, merged_into: null },
    },
    select: { event_id: true },
    distinct: ["event_id"],
  })
  return new Set(rows.map((r) => r.event_id))
}
