/*
 * inviteMember is the one door that writes an `organisation_invites` row and
 * mails it (SCRUM-1245). Before this, one org admin could mail any address from
 * our domain without limit. Two bounds now: per-user windows on invites created
 * (20 an hour, 50 a day), and at most 50 pending invites per organisation.
 *
 * The pending count runs against an in-memory table that honours whatever
 * `where` the action passes, so leaving revoked or expired rows in the count
 * fails "a revoked invite frees a slot" rather than passing on a canned number.
 */
type Row = { org_id: string; accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }
let table: Row[] = []

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cell = row[k as keyof Row]
    if (v && typeof v === "object" && !(v instanceof Date) && "gt" in v) return cell !== null && cell > (v as { gt: Date }).gt
    return cell === v
  })
}

const mockDb = {
  audit_logs: { findFirst: async () => null },
  organisations: { findUniqueOrThrow: jest.fn() },
  organisation_members: { findFirst: jest.fn() },
  organisation_invites: {
    findFirst: jest.fn(),
    create: jest.fn(),
    count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => table.filter((r) => matches(r, where)).length),
  },
}
const mockAuth = jest.fn()
const mockSend = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({ evictUserSockets: jest.fn() }))
jest.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSend(...args),
  emailConfigured: () => true,
  inviteEmail: () => ({ subject: "s", text: "t" }),
  domainVerifyEmail: () => ({ subject: "s", text: "t" }),
  appUrl: () => "http://localhost",
}))

import { inviteMember } from "@/lib/org-actions"
import { resetMemoryStore } from "@/lib/rate-limit-store"

const ORG = "11111111-1111-4111-8111-111111111111"
const OTHER_ORG = "22222222-2222-4222-8222-222222222222"
const HOUR_MS = 60 * 60 * 1000
const future = () => new Date(Date.now() + 24 * HOUR_MS)
const pending = (n: number, org = ORG): Row[] =>
  Array.from({ length: n }, () => ({ org_id: org, accepted_at: null, revoked_at: null, expires_at: future() }))

let seq = 0
/** One invite by the signed-in owner, to a fresh in-domain address. */
async function invite(email = `person${++seq}@blendn.app`, reason?: string) {
  return inviteMember(ORG, email, "staff", reason)
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  resetMemoryStore()
  table = []
  mockAuth.mockResolvedValue({ user: { id: "u1", name: "Arjun", role: "organizer" } })
  // The caller's own membership is an owner's; the invitee is never already a member.
  mockDb.organisation_members.findFirst.mockImplementation(async ({ where }: { where: { user_id?: string } }) =>
    where.user_id ? { role: "owner" } : null
  )
  mockDb.organisations.findUniqueOrThrow.mockResolvedValue({
    may_sponsor: false,
    _count: { venues: 0 },
    display_name: "Nightshift",
    domains: [{ domain: "blendn.app" }],
  })
  mockDb.organisation_invites.findFirst.mockResolvedValue(null)
  mockDb.organisation_invites.create.mockImplementation(async ({ data }: { data: Row }) => {
    table.push({ org_id: data.org_id, accepted_at: null, revoked_at: null, expires_at: data.expires_at })
    return { id: `inv_${table.length}` }
  })
  mockSend.mockResolvedValue({ sent: true })
})

describe("pending invites per organisation", () => {
  it("refuses the 51st pending invite: no row, no mail", async () => {
    table = pending(50)
    const r = await invite()
    expect(r).toEqual({ ok: false, message: "50 invites are still waiting for an answer. Revoke old ones before sending more." })
    expect(mockDb.organisation_invites.create).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("sends the 50th", async () => {
    table = pending(49)
    expect((await invite()).ok).toBe(true)
    expect(table).toHaveLength(50)
  })

  it("a revoked invite frees a slot", async () => {
    table = pending(50)
    table[0] = { ...table[0], revoked_at: new Date() }
    expect((await invite()).ok).toBe(true)
  })

  it("accepted, expired and other organisations' invites are not pending here", async () => {
    table = [
      ...pending(47),
      { org_id: ORG, accepted_at: new Date(), revoked_at: null, expires_at: future() },
      { org_id: ORG, accepted_at: null, revoked_at: null, expires_at: new Date(Date.now() - 1000) },
      ...pending(10, OTHER_ORG),
    ]
    expect((await invite()).ok).toBe(true)
  })

  it("a refusal by the cap costs nothing from the sender's window", async () => {
    table = pending(50)
    await invite()
    table = []
    for (let i = 0; i < 20; i++) expect((await invite()).ok).toBe(true)
  })
})

describe("invites per sender", () => {
  it("refuses the 21st in an hour: no row, no mail", async () => {
    for (let i = 0; i < 20; i++) expect((await invite()).ok).toBe(true)
    mockDb.organisation_invites.create.mockClear()
    mockSend.mockClear()

    const r = await invite()
    expect(r).toEqual({ ok: false, message: "That’s 20 invites in an hour. Try again in an hour." })
    expect(mockDb.organisation_invites.create).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("an invite-then-revoke loop is stopped by the window with nothing pending", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await invite()).ok).toBe(true)
      table = [] // revoked straight away
    }
    expect((await invite()).ok).toBe(false)
    expect(table).toHaveLength(0)
  })

  it("refuses the 51st in a day even when each hour stays under 20", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] })
    for (const perHour of [17, 17, 16]) {
      for (let i = 0; i < perHour; i++) {
        expect((await invite()).ok).toBe(true)
        table = [] // keep the pending cap out of it
      }
      jest.setSystemTime(Date.now() + HOUR_MS + 1)
    }
    const r = await invite()
    expect(r).toEqual({ ok: false, message: "That’s 50 invites today. Try again tomorrow." })
    expect(mockSend).toHaveBeenCalledTimes(50)
  })

  it("an outside-domain invite costs one, not two: the needsReason round trip is free", async () => {
    for (let i = 0; i < 19; i++) await invite()
    const first = await invite("freelancer@gmail.com")
    expect(first).toMatchObject({ ok: false, needsReason: true })
    expect((await invite("freelancer@gmail.com", "Photographer for the Nov 12 night")).ok).toBe(true)
    expect((await invite()).ok).toBe(false)
  })

  it("refusals before the create (already a member, outstanding invite) cost nothing", async () => {
    mockDb.organisation_invites.findFirst.mockResolvedValue({ id: "outstanding" })
    for (let i = 0; i < 25; i++) expect((await invite("same@blendn.app")).ok).toBe(false)
    mockDb.organisation_invites.findFirst.mockResolvedValue(null)
    expect((await invite()).ok).toBe(true)
  })
})

