/**
 * The charge ledger.
 *
 * Money, and money is the one place where "it was nearly right" is a
 * reconciliation somebody has to do by hand months later.
 */

const mockDb = {
  event_sponsors: { findUnique: jest.fn(), findMany: jest.fn() },
  placement_charges: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
}

const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { advanceCharge, getChargeLedger, pricePlacement } from "@/lib/charge-actions"

const PLACEMENT = "11111111-1111-4111-8111-111111111111"
const CHARGE = "22222222-2222-4222-8222-222222222222"
const ADMIN = "admin-1"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: ADMIN, role: "app_admin" } })
  mockDb.event_sponsors.findUnique.mockResolvedValue({
    id: PLACEMENT,
    event_id: "event-1",
    sponsor_id: "sponsor-1",
    status: "approved",
  })
  mockDb.placement_charges.findFirst.mockResolvedValue(null)
  mockDb.placement_charges.create.mockResolvedValue({ id: CHARGE })
})

describe("who may touch money", () => {
  it("refuses everyone but an admin", async () => {
    for (const role of ["organizer", "venue_owner", "sponsor", "attendee"]) {
      mockAuth.mockResolvedValue({ user: { id: "u", role } })
      await expect(pricePlacement(PLACEMENT, { amount: 100 })).rejects.toThrow(/forbidden/i)
      await expect(getChargeLedger()).rejects.toThrow(/forbidden/i)
    }
    expect(mockDb.placement_charges.create).not.toHaveBeenCalled()
  })
})

describe("pricing", () => {
  it("stores minor units as an integer", async () => {
    await pricePlacement(PLACEMENT, { amount: 1250.5 })

    // ₹1,250.50 is 125050 paise. A float would be fine until it was not, and
    // the first time it is not is a reconciliation off by a paisa.
    const data = mockDb.placement_charges.create.mock.calls[0][0].data
    expect(data.amount_minor).toBe(125050)
    expect(Number.isInteger(data.amount_minor)).toBe(true)
    expect(data.currency).toBe("INR")
    expect(data.status).toBe("draft")
    expect(data.priced_by).toBe(ADMIN)
  })

  it("rounds at the boundary, once", async () => {
    // A person typed this. Every read from here on is an integer.
    await pricePlacement(PLACEMENT, { amount: 0.015 })
    expect(mockDb.placement_charges.create.mock.calls[0][0].data.amount_minor).toBe(2)
  })

  it("refuses a second live charge on the same placement", async () => {
    mockDb.placement_charges.findFirst.mockResolvedValue({ id: "existing" })

    /*
     * The partial unique index is what makes this true. This check is what makes
     * it a sentence instead of a constraint violation surfacing as a 500.
     */
    await expect(pricePlacement(PLACEMENT, { amount: 100 })).rejects.toThrow(/already has a charge/i)
    expect(mockDb.placement_charges.create).not.toHaveBeenCalled()
  })

  it("looks past voided charges when deciding that", async () => {
    await pricePlacement(PLACEMENT, { amount: 100 })

    // `void` exists precisely so a mistake can be corrected. A check that
    // counted voided rows would make the first typo permanent.
    expect(mockDb.placement_charges.findFirst.mock.calls[0][0].where.status).toEqual({
      not: "void",
    })
  })

  it("refuses a placement nobody approved", async () => {
    mockDb.event_sponsors.findUnique.mockResolvedValue({
      id: PLACEMENT,
      event_id: "event-1",
      sponsor_id: "sponsor-1",
      status: "proposed",
    })

    await expect(pricePlacement(PLACEMENT, { amount: 100 })).rejects.toThrow(/not approved/i)
  })

  it("refuses a zero or negative amount", async () => {
    await expect(pricePlacement(PLACEMENT, { amount: 0 })).rejects.toThrow()
    await expect(pricePlacement(PLACEMENT, { amount: -50 })).rejects.toThrow()
    expect(mockDb.placement_charges.create).not.toHaveBeenCalled()
  })
})

describe("the status walk", () => {
  function charge(status: string) {
    mockDb.placement_charges.findUnique.mockResolvedValue({
      id: CHARGE,
      status,
      placement_id: PLACEMENT,
      amount_minor: 125050,
      currency: "INR",
    })
  }

  it("draft becomes agreed, and stamps when", async () => {
    charge("draft")
    await advanceCharge(CHARGE, "agreed")

    const data = mockDb.placement_charges.update.mock.calls[0][0].data
    expect(data.status).toBe("agreed")
    // `agreed` is the moment it becomes a receivable. Collapsing it into `draft`
    // loses the difference between "we asked" and "they said yes".
    expect(data.agreed_at).toBeInstanceOf(Date)
  })

  it("will not settle a charge nobody agreed to", async () => {
    charge("draft")
    await expect(advanceCharge(CHARGE, "settled", "NEFT-123")).rejects.toThrow(/cannot become/i)
    expect(mockDb.placement_charges.update).not.toHaveBeenCalled()
  })

  it("will not walk backwards", async () => {
    charge("settled")
    await expect(advanceCharge(CHARGE, "agreed")).rejects.toThrow(/cannot become/i)
  })

  it("refuses a settlement with no reference", async () => {
    charge("agreed")

    // A settlement nobody can check against a bank statement is the one thing
    // this row exists to make checkable.
    await expect(advanceCharge(CHARGE, "settled")).rejects.toThrow(/reference/i)
    await expect(advanceCharge(CHARGE, "settled", "  ")).rejects.toThrow(/reference/i)
    expect(mockDb.placement_charges.update).not.toHaveBeenCalled()
  })

  it("settles with a reference", async () => {
    charge("agreed")
    await advanceCharge(CHARGE, "settled", "NEFT-99213")

    const data = mockDb.placement_charges.update.mock.calls[0][0].data
    expect(data.status).toBe("settled")
    expect(data.settled_at).toBeInstanceOf(Date)
    expect(data.external_ref).toBe("NEFT-99213")
  })

  it("voids from any live state, including settled", async () => {
    for (const from of ["draft", "agreed", "settled"]) {
      jest.clearAllMocks()
      charge(from)
      // Money comes back sometimes. What must not happen is a settled charge
      // quietly becoming a draft again.
      await advanceCharge(CHARGE, "void")
      expect(mockDb.placement_charges.update.mock.calls[0][0].data.status).toBe("void")
    }
  })

  it("refuses to move an already-voided charge", async () => {
    charge("void")
    await expect(advanceCharge(CHARGE, "agreed")).rejects.toThrow(/voided/i)
  })
})

describe("the ledger", () => {
  function placements(rows: unknown[]) {
    mockDb.event_sponsors.findMany.mockResolvedValue(rows)
  }

  const base = {
    id: PLACEMENT,
    status: "approved",
    sponsor: { name: "Red Bull", org: { display_name: "Red Bull India" } },
    event: {
      id: "event-1",
      title: "Night one",
      start_time: new Date("2026-08-01T18:00:00Z"),
      end_time: new Date("2026-08-01T23:00:00Z"),
      sponsored_messages: [{ _count: { sends: 4 } }],
    },
    charges: [],
  }

  it("lists placements with no charge, which is the point of the screen", async () => {
    placements([base])

    const ledger = await getChargeLedger()

    // A list of charges answers "what have we billed". The gap is what loses
    // money, so an unpriced placement has to be a row.
    expect(ledger.placements).toHaveLength(1)
    expect(ledger.placements[0].charge).toBeNull()
    expect(ledger.placements[0].sends).toBe(4)
  })

  it("ignores voided charges when reading the live one", async () => {
    placements([base])
    await getChargeLedger()

    expect(mockDb.event_sponsors.findMany.mock.calls[0][0].select.charges.where.status).toEqual({
      not: "void",
    })
  })

  it("totals per currency, never across them", async () => {
    placements([
      {
        ...base,
        charges: [
          {
            id: "c1",
            amount_minor: 125050,
            currency: "INR",
            status: "settled",
            agreed_at: new Date(),
            settled_at: new Date(),
            external_ref: "NEFT-1",
            created_at: new Date(),
            pricer: { name: "Admin" },
          },
        ],
      },
      {
        ...base,
        id: "placement-2",
        charges: [
          {
            id: "c2",
            amount_minor: 50000,
            currency: "INR",
            status: "agreed",
            agreed_at: new Date(),
            settled_at: null,
            external_ref: null,
            created_at: new Date(),
            pricer: { name: "Admin" },
          },
        ],
      },
    ])

    const ledger = await getChargeLedger()

    /*
     * One bucket per currency. Summing minor units across currencies yields a
     * number in no currency at all, and `currency_code` having one value today
     * is exactly when this is cheap to get right.
     */
    expect(ledger.totals).toEqual([{ currency: "INR", settledMinor: 125050, agreedMinor: 50000 }])
  })

  it("counts a draft toward neither total", async () => {
    placements([
      {
        ...base,
        charges: [
          {
            id: "c1",
            amount_minor: 999900,
            currency: "INR",
            status: "draft",
            agreed_at: null,
            settled_at: null,
            external_ref: null,
            created_at: new Date(),
            pricer: { name: "Admin" },
          },
        ],
      },
    ])

    const ledger = await getChargeLedger()

    // A price somebody typed is not a receivable. Counting it as one overstates
    // what is owed, which is the direction that gets noticed too late.
    expect(ledger.totals).toEqual([{ currency: "INR", settledMinor: 0, agreedMinor: 0 }])
  })
})

describe("the ledger counts each brand's own sends", () => {
  /*
   * Two readers of one relation gave two answers, and this is the one used to
   * decide what to bill.
   *
   * `getChargeLedger` selected `event.sponsored_messages` with no filter, so a
   * row for brand A showed the sends of every sponsor at that event. Two brands
   * at one night and both rows read double. `getSponsorOverview` has always
   * filtered the same relation by `sponsor_id`.
   *
   * Control run, not registered: this is behavioural rather than structural, so
   * it cannot pass vacuously against broken code the way a source-scanning
   * guard can. Removing the `.filter((m) => m.sponsor_id === r.sponsor.id)`
   * from the sends sum fails both assertions below.
   */
  const brandA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const brandB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

  const rowFor = (sponsorId: string, name: string) => ({
    id: `p-${name}`,
    status: "approved",
    sponsor: { id: sponsorId, name, org: { display_name: "Org" } },
    event: {
      id: "evt-1",
      title: "One night",
      start_time: new Date("2026-08-05T19:00:00Z"),
      end_time: new Date("2026-08-05T23:00:00Z"),
      // BOTH brands' campaigns come back on the event, which is the point.
      sponsored_messages: [
        { sponsor_id: brandA, _count: { sends: 3 } },
        { sponsor_id: brandB, _count: { sends: 7 } },
      ],
    },
    charges: [],
  })

  it("attributes sends to the brand whose placement the row is", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN, role: "app_admin" } })
    mockDb.event_sponsors.findMany.mockResolvedValue([
      rowFor(brandA, "Alpha"),
      rowFor(brandB, "Beta"),
    ])

    const { placements } = await getChargeLedger()

    expect(placements.find((r) => r.brandName === "Alpha")!.sends).toBe(3)
    expect(placements.find((r) => r.brandName === "Beta")!.sends).toBe(7)
    // The old behaviour: both rows reading the event's total.
    expect(placements.every((r) => r.sends !== 10)).toBe(true)
  })

  it("reports zero for a brand that sent nothing, not the event's total", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN, role: "app_admin" } })
    const row = rowFor(brandA, "Alpha")
    row.event.sponsored_messages = [{ sponsor_id: brandB, _count: { sends: 7 } }]
    mockDb.event_sponsors.findMany.mockResolvedValue([row])

    const { placements } = await getChargeLedger()
    expect(placements[0].sends).toBe(0)
  })
})
