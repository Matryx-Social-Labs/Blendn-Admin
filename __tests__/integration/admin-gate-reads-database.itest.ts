/**
 * An admin action asks the database who is calling, not the session cookie.
 *
 * The session below always claims `app_admin`. The row behind it is an
 * organiser (demoted since signing in) or a suspended admin, and each admin
 * action is refused with nothing written — read back from the tables, not
 * inferred from the throw. The same calls from a real admin's row do write,
 * so the refusals are not a fixture that could never have written anything.
 *
 * One action from each of five files: amenity, category, users, onboarding
 * (an organisation's may-sponsor grant) and curation, which answers with
 * `{ ok: false }` rather than a throw and must keep doing so. And the reads
 * whose admin branch is the whole platform: `actorFor` (every permission
 * check), the audit log and the overview.
 */
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { updateUserRole } from "@/app/dashboard/users/actions"
import { curateEvent, type CurateInput } from "@/app/dashboard/events/curate/actions"
import { createAmenity } from "@/lib/amenity-actions"
import { createCategory } from "@/lib/category-actions"
import { setOrganisationMaySponsor } from "@/lib/onboarding-actions"
import { getDashboardOverview } from "@/app/dashboard/actions"
import { getAuditLog } from "@/lib/audit-actions"
import { actorFor } from "@/lib/org-membership"
import { updateVenue } from "@/lib/venue-actions"

import { db, closeDb, makeUser, testId } from "./helpers"

const users: string[] = []
const orgs: string[] = []
const tag = testId("gate").slice(-8)
let admin = ""
let demoted = ""
let suspended = ""
let target = ""

const as = (id: string) => {
  // Every caller's cookie says app_admin. Only the row differs.
  session = { user: { id, role: "app_admin" } }
}

beforeAll(async () => {
  admin = await makeUser("gate_admin", "app_admin")
  demoted = await makeUser("gate_demoted", "organizer")
  suspended = await makeUser("gate_suspended", "app_admin")
  target = await makeUser("gate_target", "attendee")
  users.push(admin, demoted, suspended, target)
  await db.user.update({ where: { id: suspended }, data: { suspended_at: new Date() } })
})

afterAll(async () => {
  await db.amenities.deleteMany({ where: { name: { startsWith: `Gate ${tag}` } } })
  await db.categories.deleteMany({ where: { name: { startsWith: `Gate ${tag}` } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  if (orgs.length) await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.venues.deleteMany({ where: { name: { startsWith: `Gate ${tag}` } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function newOrg() {
  const org = await db.organisations.create({ data: { display_name: testId("Gate Org"), status: "verified" } })
  orgs.push(org.id)
  return org.id
}

describe.each([
  ["an admin demoted to organiser since signing in", () => demoted],
  ["a suspended admin", () => suspended],
])("%s, with a session that still says app_admin", (_label, caller) => {
  it("is refused every admin action, and nothing is written", async () => {
    const org = await newOrg()
    const name = `Gate ${tag} ${caller().slice(-6)}`
    as(caller())

    await expect(createAmenity({ name })).rejects.toThrow("Forbidden")
    await expect(createCategory(name, null)).rejects.toThrow("Forbidden")
    await expect(updateUserRole(target, "organizer")).rejects.toThrow("Forbidden")
    await expect(setOrganisationMaySponsor(org, true, "Agreement GATE-1, signed 2026-10-10")).rejects.toThrow("Forbidden")
    // The one that answers with a result: still a refusal, in its own words.
    expect(await curateEvent({} as CurateInput)).toEqual({ ok: false, error: "Only platform admins can curate events" })

    expect(await db.amenities.count({ where: { name } })).toBe(0)
    expect(await db.categories.count({ where: { name } })).toBe(0)
    expect((await db.user.findUniqueOrThrow({ where: { id: target }, select: { role: true } })).role).toBe("attendee")
    expect((await db.organisations.findUniqueOrThrow({ where: { id: org }, select: { may_sponsor: true } })).may_sponsor).toBe(false)
    expect(await db.audit_logs.count({ where: { user_id: caller() } })).toBe(0)
  })
})

describe("the same calls from an admin's row", () => {
  it("write, so the refusals above are not a fixture that could never write", async () => {
    const org = await newOrg()
    const name = `Gate ${tag} admin`
    as(admin)

    await createAmenity({ name })
    await createCategory(name, null)
    await setOrganisationMaySponsor(org, true, "Agreement GATE-1, signed 2026-10-10")
    await updateUserRole(target, "organizer")

    expect(await db.amenities.count({ where: { name } })).toBe(1)
    expect(await db.categories.count({ where: { name } })).toBe(1)
    expect((await db.organisations.findUniqueOrThrow({ where: { id: org }, select: { may_sponsor: true } })).may_sponsor).toBe(true)
    expect((await db.user.findUniqueOrThrow({ where: { id: target }, select: { role: true } })).role).toBe("organizer")
  })
})

describe("the reads whose admin branch is the whole platform", () => {
  it("build the actor from the row: an organiser's role and orgs, a suspended admin nobody", async () => {
    // What callers pass is a session's user; the claim says app_admin.
    expect(await actorFor({ id: demoted, role: "app_admin" })).toEqual({ id: demoted, role: "organizer", orgIds: [] })
    expect(await actorFor({ id: suspended, role: "app_admin" })).toEqual({ id: suspended, role: "attendee", orgIds: [] })
    expect(await actorFor({ id: admin, role: "organizer" })).toEqual({ id: admin, role: "app_admin", orgIds: [] })
  })

  it("scope the audit log to the caller's organisations unless the row is an admin's", async () => {
    // An organiser who manages no organisation reads nothing, never the platform's log.
    as(demoted)
    await expect(getAuditLog()).rejects.toThrow("Forbidden")
    as(suspended)
    await expect(getAuditLog()).rejects.toThrow("Unauthorized")
    as(admin)
    expect((await getAuditLog()).scopedToOrg).toBe(false)
  })

  it("answer the overview for the row's role, never the platform's for a demoted admin", async () => {
    as(demoted)
    expect((await getDashboardOverview()).role).toBe("organizer")
    as(suspended)
    await expect(getDashboardOverview()).rejects.toThrow("Not authorised")
  })
})

describe("a venue's admin branch", () => {
  it("is the row's: a demoted admin cannot edit a venue their organisation does not own", async () => {
    const venue = await db.venues.create({ data: { name: `Gate ${tag} venue`, city: "Bengaluru", latitude: 12.97, longitude: 77.6 } })
    as(demoted)
    await expect(updateVenue(venue.id, { name: `Gate ${tag} renamed` })).rejects.toThrow("Forbidden")
    expect((await db.venues.findUniqueOrThrow({ where: { id: venue.id }, select: { name: true } })).name).toBe(`Gate ${tag} venue`)
    as(admin)
    await updateVenue(venue.id, { name: `Gate ${tag} renamed` })
    expect((await db.venues.findUniqueOrThrow({ where: { id: venue.id }, select: { name: true } })).name).toBe(`Gate ${tag} renamed`)
  })
})
