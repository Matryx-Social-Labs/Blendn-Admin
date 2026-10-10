/**
 * An organisation's audit log is the organisation's (step 18 security review, M3).
 *
 * Two organisations and one person who belongs to both. The log used to be
 * "rows written by our members", so A's owner read the shared member's
 * actions for B — and a new member's whole history from before they joined.
 * A row now carries the organisation it belongs to, written when the actor
 * is a member of the organisation that owns the resource; older rows keep the
 * member rule, bounded to what each member wrote since joining.
 */
let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { auditInTx } from "@/lib/audit-log"
import { getAuditLog } from "@/lib/audit-actions"

import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const tag = testId("aos")

let ownerA = ""
let ownerB = ""
let shared = ""
let newcomer = ""
let admin = ""
let orgA = ""
let orgB = ""
let venueA = ""
let venueB = ""

const as = (id: string, role = "organizer") => {
  session = { user: { id, role } }
}

async function org(label: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(o.id)
  return o.id
}

async function venue(ownerOrg: string) {
  const v = await db.venues.create({
    data: { name: `${tag} venue`, city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: ownerOrg, claimed_at: new Date() },
  })
  venues.push(v.id)
  return v.id
}

/** A row written by today's code, through the one writer. */
async function act(userId: string, venueId: string, action: string) {
  await db.$transaction((tx) => auditInTx(tx, { userId, action: `${tag}.${action}`, resource: "venue", resourceId: venueId }))
  return db.audit_logs.findFirstOrThrow({ where: { action: `${tag}.${action}` } })
}

/** A row from before `org_id` existed, at a given time. */
async function legacy(userId: string, action: string, at: Date) {
  return db.audit_logs.create({
    data: { user_id: userId, action: `${tag}.${action}`, resource: "venue", pre_org_scope: true, created_at: at },
  })
}

const seenBy = async (viewer: string) => {
  as(viewer)
  return new Set((await getAuditLog()).entries.filter((e) => e.action.startsWith(tag)).map((e) => e.action.slice(tag.length + 1)))
}

beforeAll(async () => {
  ownerA = await makeUser("aos_ownerA", "organizer")
  ownerB = await makeUser("aos_ownerB", "organizer")
  shared = await makeUser("aos_shared", "organizer")
  newcomer = await makeUser("aos_new", "organizer")
  admin = await makeUser("aos_admin", "app_admin")
  users.push(ownerA, ownerB, shared, newcomer, admin)
  orgA = await org("AOS A")
  orgB = await org("AOS B")
  const longAgo = new Date(Date.now() - 30 * 86_400_000)
  await db.organisation_members.createMany({
    data: [
      { org_id: orgA, user_id: ownerA, role: "owner", created_at: longAgo },
      { org_id: orgB, user_id: ownerB, role: "owner", created_at: longAgo },
      { org_id: orgA, user_id: shared, role: "staff", created_at: longAgo },
      { org_id: orgB, user_id: shared, role: "staff", created_at: longAgo },
      // Joined A yesterday.
      { org_id: orgA, user_id: newcomer, role: "staff", created_at: new Date(Date.now() - 86_400_000) },
    ],
  })
  venueA = await venue(orgA)
  venueB = await venue(orgB)
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { action: { startsWith: tag } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

it("writes the organisation a row belongs to: the resource's owner, when the actor is one of them", async () => {
  expect((await act(shared, venueB, "w-shared-on-B")).org_id).toBe(orgB)
  expect((await act(shared, venueA, "w-shared-on-A")).org_id).toBe(orgA)
  // An admin acting on A's venue is not A acting: the platform's row.
  expect((await act(admin, venueA, "w-admin-on-A")).org_id).toBeNull()
  // Nor is a member of B acting on A's venue.
  expect((await act(ownerB, venueA, "w-ownerB-on-A")).org_id).toBeNull()
})

it("shows each organisation its own rows, and the old ones only from members since they joined", async () => {
  await act(shared, venueB, "shared-on-B")
  await act(shared, venueA, "shared-on-A")
  await act(admin, venueA, "admin-on-A")
  await legacy(shared, "old-shared", new Date(Date.now() - 2 * 86_400_000))
  await legacy(newcomer, "old-newcomer-before-joining", new Date(Date.now() - 5 * 86_400_000))
  await legacy(newcomer, "old-newcomer-after-joining", new Date(Date.now() - 3_600_000))
  await legacy(ownerB, "old-ownerB", new Date(Date.now() - 2 * 86_400_000))

  const a = await seenBy(ownerA)
  expect(a.has("shared-on-A")).toBe(true)
  expect(a.has("old-shared")).toBe(true)
  expect(a.has("old-newcomer-after-joining")).toBe(true)
  // The leaks: the shared member's work for B, a newcomer's past, an admin's act, B's owner.
  expect(a.has("shared-on-B")).toBe(false)
  expect(a.has("old-newcomer-before-joining")).toBe(false)
  expect(a.has("admin-on-A")).toBe(false)
  expect(a.has("old-ownerB")).toBe(false)

  const b = await seenBy(ownerB)
  expect(b.has("shared-on-B")).toBe(true)
  expect(b.has("shared-on-A")).toBe(false)
  expect(b.has("old-ownerB")).toBe(true)
  // The shared member's old row is B's too: they were B's member when it was written.
  expect(b.has("old-shared")).toBe(true)

  // The platform reads everything (by action: its page is the newest hundred of the whole table).
  as(admin, "app_admin")
  for (const k of ["shared-on-A", "shared-on-B", "admin-on-A", "old-newcomer-before-joining"]) {
    expect((await getAuditLog({ action: `${tag}.${k}` })).total).toBe(1)
  }
})
