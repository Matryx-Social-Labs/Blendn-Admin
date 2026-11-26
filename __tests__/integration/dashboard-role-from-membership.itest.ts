/*
 * Dashboard entry from membership, against real Postgres (SCRUM-1247).
 *
 * The unit suite mocks the read; this one runs the jwt callback's own query, so what it proves is the SQL: only a live
 * organisation's membership counts (`activeMembership`), the home one is the oldest, and only live venues and live,
 * unmerged brands make an organisation a venue or a sponsor.
 */
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))

import pg from "pg"

import { authOptions } from "@/lib/auth"
import { sessionAccount, signinAccount } from "@/lib/org-membership"
import { SessionEnded } from "@/lib/session-revocation"
import { closeDb, cleanup, db, makeUser, testId } from "./helpers"

const jwt = (authOptions.callbacks as unknown as { jwt: (a: { token: Record<string, unknown> }) => Promise<Record<string, unknown>> }).jwt
const session = (sub: string) => jwt({ token: { sub, role: "attendee", signedInAt: Date.now() } })

const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const brands: string[] = []

afterAll(async () => {
  await db.organiser_onboarding_requests.deleteMany({ where: { org_id: { in: orgs } } })
  await db.sponsors.deleteMany({ where: { id: { in: brands } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function person(role: "attendee" | "organizer" | "app_admin" = "attendee") {
  const id = await makeUser(testId("dr"), role)
  users.push(id)
  return id
}

async function org(kind: "events" | "venue" | "brand" | "may_sponsor" | "venue+brand" | "venue+may_sponsor" = "events") {
  const o = await db.organisations.create({
    data: { display_name: testId("dr-org"), kind: "company", status: "verified", may_sponsor: kind.endsWith("may_sponsor") },
  })
  orgs.push(o.id)
  if (kind.startsWith("venue")) {
    const v = await db.venues.create({
      data: { name: testId("dr-venue"), city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: o.id, claimed_at: new Date() },
    })
    venues.push(v.id)
  }
  if (kind.endsWith("brand")) {
    const b = await db.sponsors.create({ data: { name: testId("dr-brand"), name_key: testId("drbrand"), org_id: o.id } })
    brands.push(b.id)
  }
  return o.id
}

/** The org's approved application, as `approveOnboardingRequest` leaves it. */
const applied = (orgId: string, requested_role: "organizer" | "venue_owner" | "sponsor") =>
  db.organiser_onboarding_requests.create({
    data: { org_id: orgId, display_name: testId("dr-app"), contact_name: "A", contact_email: `${testId("dr-app")}@itest.invalid`, requested_role, status: "approved" },
  })

const join = (userId: string, orgId: string, created_at?: Date) =>
  db.organisation_members.create({ data: { org_id: orgId, user_id: userId, role: "staff", ...(created_at && { created_at }) } })

describe("the session's role, from the database", () => {
  it.each([
    ["events", "organizer"],
    ["venue", "venue_owner"],
    ["brand", "sponsor"],
    ["may_sponsor", "sponsor"],
  ] as const)("an attendee-role member of a %s org is %s", async (kind, role) => {
    const p = await person()
    await join(p, await org(kind))
    await expect(session(p)).resolves.toMatchObject({ role, inviteOnly: false })
  })

  it.each([
    ["venue+brand", "sponsor"],
    ["venue+may_sponsor", "sponsor"],
  ] as const)("a %s org is %s: a brand's before a venue's", async (kind, role) => {
    const p = await person()
    await join(p, await org(kind))
    await expect(session(p)).resolves.toMatchObject({ role })
  })

  it.each([
    ["venue_owner", "venue_owner"],
    ["sponsor", "sponsor"],
    ["organizer", "organizer"],
  ] as const)("an org with nothing yet is what its approved application asked to be: %s", async (asked, role) => {
    // A venue owner approved this morning has no venue until their first claim, and the claim needs the role.
    const p = await person()
    const o = await org()
    await applied(o, asked)
    await join(p, o)
    await expect(session(p)).resolves.toMatchObject({ role })
  })

  it("a declined or pending application asks for nothing", async () => {
    const p = await person()
    const o = await org()
    const app = await applied(o, "venue_owner")
    await db.organiser_onboarding_requests.update({ where: { id: app.id }, data: { status: "declined" } })
    await join(p, o)
    await expect(session(p)).resolves.toMatchObject({ role: "organizer" })
  })

  it("two memberships at the same moment: the lower org id is home", async () => {
    const p = await person()
    const [a, b] = [await org("venue"), await org()]
    const at = new Date("2026-01-01T00:00:00Z")
    await join(p, a, at)
    await join(p, b, at)
    const home = a < b ? "venue_owner" : "organizer"
    await expect(session(p)).resolves.toMatchObject({ role: home })
  })

  it("a host who leaves their last org has no dashboard on the next read", async () => {
    const p = await person()
    const o = await org()
    await join(p, o)
    await expect(session(p)).resolves.toMatchObject({ role: "organizer" })
    await db.organisation_members.deleteMany({ where: { user_id: p } })
    await expect(session(p)).rejects.toThrow(SessionEnded)
  })

  it("a suspended org grants nothing: with no other membership and no invite the session ends", async () => {
    const p = await person()
    const o = await org()
    await join(p, o)
    await db.organisations.update({ where: { id: o }, data: { status: "suspended" } })
    await expect(session(p)).rejects.toThrow(SessionEnded)
  })

  it("the home org is the oldest live one: a suspended older org is skipped", async () => {
    const p = await person()
    const older = await org("venue")
    await join(p, older, new Date("2026-01-01T00:00:00Z"))
    await join(p, await org(), new Date("2026-02-01T00:00:00Z"))
    await expect(session(p)).resolves.toMatchObject({ role: "venue_owner" })
    await db.organisations.update({ where: { id: older }, data: { status: "suspended" } })
    await expect(session(p)).resolves.toMatchObject({ role: "organizer" })
  })

  it("a deleted venue and a merged or deleted brand do not make the kind", async () => {
    const p = await person()
    const o = await org("venue")
    await db.venues.updateMany({ where: { owner_org_id: o }, data: { deleted_at: new Date() } })
    const deleted = await db.sponsors.create({ data: { name: testId("dr-d"), name_key: testId("drd"), org_id: o, deleted_at: new Date() } })
    const winner = await db.sponsors.create({ data: { name: testId("dr-w"), name_key: testId("drw") } })
    const merged = await db.sponsors.create({ data: { name: testId("dr-m"), name_key: testId("drm"), org_id: o, merged_into: winner.id } })
    brands.push(deleted.id, winner.id, merged.id)
    await join(p, o)
    await expect(session(p)).resolves.toMatchObject({ role: "organizer" })
  })

  it("an organizer-role row with no membership has no dashboard: the session ends", async () => {
    await expect(session(await person("organizer"))).rejects.toThrow(SessionEnded)
  })

  it("an app_admin stays app_admin whatever their memberships", async () => {
    const p = await person("app_admin")
    await join(p, await org("venue"))
    await expect(jwt({ token: { sub: p, role: "app_admin", signedInAt: Date.now() } })).resolves.toMatchObject({ role: "app_admin" })
  })

  it("a suspended user's session ends, memberships or not", async () => {
    const p = await person()
    await join(p, await org())
    await db.user.update({ where: { id: p }, data: { suspended_at: new Date() } })
    await expect(session(p)).rejects.toThrow(SessionEnded)
  })
})

/** SQL statements sent while `run` runs, through every pg client (the app's pool included). */
async function statements(run: () => Promise<unknown>): Promise<number> {
  let n = 0
  const query = pg.Client.prototype.query
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) {
    n++
    return (query as (...x: unknown[]) => unknown).apply(this, a)
  } as typeof query
  try {
    await run().catch(() => undefined)
  } finally {
    pg.Client.prototype.query = query
  }
  return n
}

describe("what a session read costs", () => {
  it("is one statement for a host, as before; two for an invite's session (the invite), as before", async () => {
    const host = await person()
    await join(host, await org("venue"))
    await session(host) // a warm pool, as in production
    expect(await statements(() => session(host))).toBe(1)
    const invited = await person()
    expect(await statements(() => session(invited))).toBe(2)
  })

  it("reads the same account the Prisma read did, timestamps included", async () => {
    const p = await person()
    await join(p, await org())
    const at = new Date("2026-03-04T05:06:07.123Z")
    await db.user.update({ where: { id: p }, data: { password_changed_at: at, sessions_revoked_at: at, suspended_at: at, deletedAt: at } })
    const prisma = await db.user.findUniqueOrThrow({
      where: { id: p },
      select: { id: true, email: true, name: true, role: true, suspended_at: true, deletedAt: true, password_changed_at: true, sessions_revoked_at: true },
    })
    await expect(sessionAccount(p)).resolves.toEqual({ ...prisma, dashboardRole: "organizer" })
    await expect(signinAccount(prisma.email)).resolves.toMatchObject({ ...prisma, password: null, dashboardRole: "organizer" })
    await db.user.update({ where: { id: p }, data: { password: "a-hash" } })
    await expect(signinAccount(prisma.email)).resolves.toMatchObject({ id: p, password: "a-hash" })
    await expect(signinAccount("no-such@itest.invalid")).resolves.toBeNull()
    await expect(sessionAccount("no-such-user")).resolves.toBeNull()
  })
})
