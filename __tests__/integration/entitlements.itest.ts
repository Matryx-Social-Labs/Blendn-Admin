/*
 * MN-U01 against real Postgres, built with `migrate deploy`: what
 * `hasEntitlement` answers, and the shape the migration's CHECKs hold every
 * row to (they exist only in migration SQL; `db push` drops them).
 */
import { endGrant, grantEntitlement, hasEntitlement, liveEntitlement } from "@/lib/entitlements"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const DAY = 24 * 60 * 60 * 1000
const now = new Date("2026-10-03T12:00:00Z")
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let orgA = ""
let orgB = ""
let eventId = ""
let otherEventId = ""

beforeAll(async () => {
  const host = await makeUser(testId("ent-host"), "organizer")
  users.push(host)
  for (const label of ["ent-a", "ent-b"]) {
    const org = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
    orgs.push(org.id)
  }
  ;[orgA, orgB] = orgs
  eventId = await makeEvent(host)
  otherEventId = await makeEvent(host)
  events.push(eventId, otherEventId)
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { OR: [{ subject_id: { in: orgs } }, { event_id: { in: events } }] } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

async function row(data: {
  subject_id: string
  product?: "analytics" | "event_pass"
  event_id?: string | null
  starts_at?: Date
  expires_at?: Date | null
  source?: "grant" | "razorpay"
}) {
  return db.entitlements.create({
    data: {
      subject_kind: "org",
      subject_id: data.subject_id,
      product: data.product ?? "analytics",
      event_id: data.event_id ?? null,
      source: data.source ?? "grant",
      external_ref: data.source === "razorpay" ? testId("ref") : null,
      starts_at: data.starts_at ?? new Date(now.getTime() - DAY),
      expires_at: data.expires_at === undefined ? new Date(now.getTime() + DAY) : data.expires_at,
    },
  })
}

describe("hasEntitlement", () => {
  afterEach(async () => {
    await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  })

  it("is false with no row", async () => {
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, now)).toBe(false)
  })

  it("is true inside the window and false either side of it", async () => {
    await row({ subject_id: orgA })
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, now)).toBe(true)
    // At the exact end it has ended.
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, new Date(now.getTime() + DAY))).toBe(false)
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, new Date(now.getTime() - 2 * DAY))).toBe(false)
  })

  it("is false for an expired row and for one that has not started", async () => {
    await row({ subject_id: orgA, starts_at: new Date(now.getTime() - 3 * DAY), expires_at: new Date(now.getTime() - DAY) })
    await row({ subject_id: orgA, starts_at: new Date(now.getTime() + DAY), expires_at: new Date(now.getTime() + 2 * DAY) })
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, now)).toBe(false)
  })

  it("treats a NULL end as never ending", async () => {
    await row({ subject_id: orgA, expires_at: null, product: "event_pass", event_id: eventId, source: "razorpay" })
    expect(await hasEntitlement({ kind: "org", id: orgA }, "event_pass", { eventId }, new Date("2036-01-01"))).toBe(true)
  })

  it("answers for its own subject, kind and product only", async () => {
    await row({ subject_id: orgA })
    expect(await hasEntitlement({ kind: "org", id: orgB }, "analytics", {}, now)).toBe(false)
    expect(await hasEntitlement({ kind: "venue", id: orgA }, "analytics", {}, now)).toBe(false)
    expect(await hasEntitlement({ kind: "user", id: orgA }, "analytics", {}, now)).toBe(false)
    expect(await hasEntitlement({ kind: "org", id: orgA }, "event_pass", { eventId }, now)).toBe(false)
  })

  it("scopes an Event Pass to its one event", async () => {
    await row({ subject_id: orgA, product: "event_pass", event_id: eventId, source: "razorpay" })
    expect(await hasEntitlement({ kind: "org", id: orgA }, "event_pass", { eventId }, now)).toBe(true)
    expect(await hasEntitlement({ kind: "org", id: orgA }, "event_pass", { eventId: otherEventId }, now)).toBe(false)
    // Without an event it is not "any pass at all".
    expect(await hasEntitlement({ kind: "org", id: orgA }, "event_pass", {}, now)).toBe(false)
    // A pass is not Analytics.
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, now)).toBe(false)
  })
})

describe("grants", () => {
  afterEach(async () => {
    await db.entitlements.deleteMany({ where: { subject_id: { in: orgs } } })
  })

  it("a six-month grant opens Analytics for six calendar months, and ending it closes it now", async () => {
    const grant = await grantEntitlement({ subject: { kind: "org", id: orgA }, product: "analytics", months: 6, now })
    expect(grant.expiresAt.toISOString()).toBe("2027-04-03T12:00:00.000Z")
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, now)).toBe(true)
    expect((await liveEntitlement({ kind: "org", id: orgA }, "analytics", now))?.source).toBe("grant")

    const later = new Date(now.getTime() + DAY)
    expect(await endGrant({ kind: "org", id: orgB }, grant.id, later)).toBeNull()
    const ended = await endGrant({ kind: "org", id: orgA }, grant.id, later)
    expect(ended?.expiresAt.toISOString()).toBe(later.toISOString())
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, later)).toBe(false)
    // The row is kept, ended, not deleted.
    expect(await db.entitlements.count({ where: { id: grant.id } })).toBe(1)
  })

  it("endGrant never ends a paid row", async () => {
    const paid = await row({ subject_id: orgA, source: "razorpay" })
    expect(await endGrant({ kind: "org", id: orgA }, paid.id, now)).toBeNull()
    expect(await hasEntitlement({ kind: "org", id: orgA }, "analytics", {}, now)).toBe(true)
  })
})

describe("the migration's CHECKs", () => {
  const base = {
    subject_kind: "org" as const,
    source: "grant" as const,
    starts_at: now,
    expires_at: new Date(now.getTime() + DAY),
  }
  const refused = async (data: Parameters<typeof db.entitlements.create>[0]["data"], constraint: string) => {
    await expect(db.entitlements.create({ data })).rejects.toThrow(constraint)
  }

  it("refuses Blendn+ through Razorpay", async () => {
    await refused(
      { ...base, subject_kind: "user", subject_id: users[0], product: "plus", source: "razorpay", external_ref: testId("r") },
      "entitlements_plus_not_razorpay"
    )
  })

  it("refuses a product on the wrong kind of subject", async () => {
    await refused({ ...base, subject_kind: "user", subject_id: users[0], product: "analytics" }, "entitlements_product_subject")
    await refused({ ...base, subject_id: orgA, product: "venue_pro" }, "entitlements_product_subject")
  })

  it("refuses an Event Pass without its event, and an event on anything else", async () => {
    await refused({ ...base, subject_id: orgA, product: "event_pass" }, "entitlements_event_scope")
    await refused({ ...base, subject_id: orgA, product: "analytics", event_id: eventId }, "entitlements_event_scope")
  })

  it("refuses a paid row with no provider reference, and a row that ends before it starts", async () => {
    await refused({ ...base, subject_id: orgA, product: "analytics", source: "razorpay" }, "entitlements_paid_has_ref")
    await refused(
      { ...base, subject_id: orgA, product: "analytics", expires_at: new Date(now.getTime() - 1) },
      "entitlements_window"
    )
  })

  it("holds one row per provider reference", async () => {
    const ref = testId("sub")
    await db.entitlements.create({ data: { ...base, subject_id: orgA, product: "analytics", source: "razorpay", external_ref: ref } })
    await expect(
      db.entitlements.create({ data: { ...base, subject_id: orgB, product: "analytics", source: "razorpay", external_ref: ref } })
    ).rejects.toThrow()
    await db.entitlements.deleteMany({ where: { external_ref: ref } })
  })
})
