let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { advanceCharge, getChargeLedger } from "@/lib/charge-actions"

import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * Voiding a charge is a decision with a reason, and it stays on the ledger
 * (SCRUM-173).
 *
 * On staging a settled ₹1,500 charge voided on one click: no confirmation, no
 * reason, the audit row's `externalRef` was null although the charge carried
 * one, and the placement went back to "unbilled" as if nothing had ever been
 * billed.
 */

const users: string[] = []
const events: string[] = []
const sponsors: string[] = []
let admin: string
let placementId: string
let chargeId: string

beforeAll(async () => {
  admin = await makeUser(testId("void_admin"), "app_admin")
  const host = await makeUser(testId("void_host"), "organizer")
  users.push(admin, host)
  await db.user.update({ where: { id: admin }, data: { name: "Void Admin" } })
  session = { user: { id: admin, role: "app_admin" } }

  const eventId = await makeEvent(host)
  events.push(eventId)
  const sponsor = await db.sponsors.create({ data: { name: testId("brand"), name_key: testId("brandkey"), created_by: admin } })
  sponsors.push(sponsor.id)
  placementId = (await db.event_sponsors.create({ data: { event_id: eventId, sponsor_id: sponsor.id, status: "approved", created_by: host } })).id
  chargeId = (
    await db.placement_charges.create({
      data: {
        placement_id: placementId,
        amount_minor: 150000,
        currency: "INR",
        status: "settled",
        priced_by: admin,
        agreed_at: new Date(),
        settled_at: new Date(),
        external_ref: "NEFT-QA-173",
      },
    })
  ).id
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: chargeId } })
  await db.placement_charges.deleteMany({ where: { placement_id: placementId } })
  await db.event_sponsors.deleteMany({ where: { id: placementId } })
  await db.sponsors.deleteMany({ where: { id: { in: sponsors } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const row = () => db.placement_charges.findUniqueOrThrow({ where: { id: chargeId } })

describe("voiding a charge", () => {
  it("refuses a void with no reason, or one too short to mean anything, and writes nothing", async () => {
    await expect(advanceCharge(chargeId, "void")).rejects.toThrow(/reason/i)
    await expect(advanceCharge(chargeId, "void", undefined, "oops")).rejects.toThrow(/reason/i)
    expect((await row()).status).toBe("settled")
  })

  it("records when, by whom and why, and audits the payment reference the charge carried", async () => {
    await advanceCharge(chargeId, "void", undefined, "  duplicate invoice, re-raised as the October package  ")

    const after = await row()
    expect(after.status).toBe("void")
    expect(after.voided_at).toBeInstanceOf(Date)
    expect(after.voided_by).toBe(admin)
    expect(after.void_reason).toBe("duplicate invoice, re-raised as the October package")

    const audit = await db.audit_logs.findFirstOrThrow({ where: { resource_id: chargeId, action: "charge.void" } })
    expect(audit.details).toMatchObject({
      from: "settled",
      externalRef: "NEFT-QA-173",
      reason: "duplicate invoice, re-raised as the October package",
    })
  })

  it("keeps the voided charge on its placement's ledger row as history", async () => {
    const ledger = await getChargeLedger()
    const placement = ledger.placements.find((p) => p.placementId === placementId)

    expect(placement?.charge).toBeNull()
    expect(placement?.voided).toEqual([
      expect.objectContaining({
        id: chargeId,
        amountMinor: 150000,
        currency: "INR",
        fromStatus: "settled",
        externalRef: "NEFT-QA-173",
        reason: "duplicate invoice, re-raised as the October package",
        voidedByName: "Void Admin",
      }),
    ])
  })
})
