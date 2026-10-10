/**
 * An organisation's audit log is its data's history (step 18 security review, M3).
 *
 * The log used to be "rows written by our members". So a member of two
 * organisations put their work for the other one in front of this one, and a
 * member who left took their history with them; a Blend'n admin's decision on
 * the organisation's data was never in it at all. A row now carries the
 * organisation whose data changed (`org_id`, attributed by lib/audit-log.ts
 * from the resource, whoever acted), the log reads by it, and a row that
 * cannot be attributed is never anybody's but the platform's.
 */
import { readFileSync } from "fs"
import { join } from "path"

let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { auditInTx, UnattributedAuditError } from "@/lib/audit-log"
import { getAuditLog } from "@/lib/audit-actions"

import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const tag = testId("aos")

let ownerA = ""
let ownerB = ""
let shared = ""
let leaver = ""
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

const seenBy = async (viewer: string) => {
  as(viewer)
  const log = await getAuditLog()
  return new Map(log.entries.filter((e) => e.action.startsWith(tag)).map((e) => [e.action.slice(tag.length + 1), e]))
}

beforeAll(async () => {
  ownerA = await makeUser("aos_ownerA", "organizer")
  ownerB = await makeUser("aos_ownerB", "organizer")
  shared = await makeUser("aos_shared", "organizer")
  leaver = await makeUser("aos_leaver", "organizer")
  admin = await makeUser("aos_admin", "app_admin")
  users.push(ownerA, ownerB, shared, leaver, admin)
  orgA = await org("AOS A")
  orgB = await org("AOS B")
  await db.organisation_members.createMany({
    data: [
      { org_id: orgA, user_id: ownerA, role: "owner" },
      { org_id: orgB, user_id: ownerB, role: "owner" },
      { org_id: orgA, user_id: shared, role: "staff" },
      { org_id: orgB, user_id: shared, role: "staff" },
      { org_id: orgA, user_id: leaver, role: "staff" },
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

it("a shared member's work is in the log of the organisation it was for, and only that one", async () => {
  expect((await act(shared, venueB, "shared-on-B")).org_id).toBe(orgB)
  expect((await act(shared, venueA, "shared-on-A")).org_id).toBe(orgA)

  const a = await seenBy(ownerA)
  expect(a.has("shared-on-A")).toBe(true)
  expect(a.has("shared-on-B")).toBe(false)

  const b = await seenBy(ownerB)
  expect(b.has("shared-on-B")).toBe(true)
  expect(b.has("shared-on-A")).toBe(false)
})

it("a member who has left keeps their history in the organisation's log", async () => {
  await act(leaver, venueA, "leaver-before-leaving")
  await db.organisation_members.deleteMany({ where: { org_id: orgA, user_id: leaver } })

  const a = await seenBy(ownerA)
  expect(a.has("leaver-before-leaving")).toBe(true)
  // And B never had it.
  expect((await seenBy(ownerB)).has("leaver-before-leaving")).toBe(false)
})

it("an admin's act on B's data is in B's log, as Blend'n, and not in A's", async () => {
  expect((await act(admin, venueB, "admin-on-B")).org_id).toBe(orgB)

  const b = await seenBy(ownerB)
  expect(b.has("admin-on-B")).toBe(true)
  // The platform, not a staff member's name and address.
  expect(b.get("admin-on-B")?.actor).toEqual({ id: "blendn", name: "Blend'n", email: "" })
  expect((await seenBy(ownerA)).has("admin-on-B")).toBe(false)

  // The platform reads everything, with the person.
  as(admin, "app_admin")
  const all = await getAuditLog({ action: `${tag}.admin-on-B` })
  expect(all.total).toBe(1)
  expect(all.entries[0].actor?.id).toBe(admin)
})

describe("a row about an organisation's data that cannot say which organisation", () => {
  it("is a failed write in tests", async () => {
    await expect(
      db.$transaction((tx) => auditInTx(tx, { userId: shared, action: `${tag}.no-id`, resource: "venue" }))
    ).rejects.toThrow(UnattributedAuditError)
    expect(await db.audit_logs.count({ where: { action: `${tag}.no-id` } })).toBe(0)
  })

  it("is written in production as the platform's alone, never into an organisation's log", async () => {
    const env = process.env as Record<string, string | undefined>
    const was = env.NODE_ENV
    env.NODE_ENV = "production"
    try {
      await db.$transaction((tx) => auditInTx(tx, { userId: shared, action: `${tag}.no-id-prod`, resource: "venue", resourceId: "not-a-uuid" }))
    } finally {
      env.NODE_ENV = was
    }
    const row = await db.audit_logs.findFirstOrThrow({ where: { action: `${tag}.no-id-prod` } })
    expect(row.org_id).toBeNull()
    expect((await seenBy(ownerA)).has("no-id-prod")).toBe(false)
    expect((await seenBy(ownerB)).has("no-id-prod")).toBe(false)
  })
})

it("the backfill gives the rows from before the column the organisation of their resource", async () => {
  const event = await db.events.create({
    data: {
      slug: testId("aos-evt"), title: `${tag} event`, description: "fixture", start_time: new Date(), end_time: new Date(Date.now() + 3_600_000),
      timezone: "UTC", status: "published", organizer_id: ownerA, organizer_org_id: orgA,
    },
  })
  try {
    const legacy = (resource: string, resourceId: string | null, action: string, details?: object) =>
      db.audit_logs.create({ data: { user_id: shared, action: `${tag}.${action}`, resource, resource_id: resourceId, ...(details && { details }) } })
    await legacy("venue", venueB, "old-venue-B")
    await legacy("organisation", orgA, "old-org-A")
    await legacy("event", event.id, "old-event-A")
    await legacy("chat_group_member", shared, "old-member-A", { eventId: event.id })
    await legacy("user", shared, "old-personal")

    // The migration's statements, as `prisma migrate deploy` runs them (its own transaction).
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261010130100_audit_logs_org_backfill/migration.sql"), "utf8")
    const statements = sql
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !/^(BEGIN|COMMIT|SET LOCAL)/i.test(s))
    await db.$transaction(async (tx) => {
      for (const s of statements) await tx.$executeRawUnsafe(s)
    })

    const org = async (action: string) =>
      (await db.audit_logs.findFirstOrThrow({ where: { action: `${tag}.${action}` }, select: { org_id: true } })).org_id
    expect(await org("old-venue-B")).toBe(orgB)
    expect(await org("old-org-A")).toBe(orgA)
    expect(await org("old-event-A")).toBe(orgA)
    expect(await org("old-member-A")).toBe(orgA)
    expect(await org("old-personal")).toBeNull()
  } finally {
    await db.events.delete({ where: { id: event.id } })
  }
})
