const mockWarn = jest.fn()
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), debug: jest.fn() },
}))

import { sendEmail } from "@/lib/email"

/*
 * Outside production, mail goes only to our own and test domains (SCRUM-452).
 *
 * Staging has RESEND_API_KEY and EMAIL_FROM set, and its seed data carried real
 * businesses' addresses — events@toit.in, bookings@in.bookmyshow.com — so a
 * tester deciding a seeded claim emailed a real company. It already happened:
 * a gmail.com applicant got a staging mail on 2026-09-15.
 *
 * `fetch` is the Resend client here (lib/email.ts has no SDK), so "Resend was
 * not called" means "fetch was not called".
 */
const ENV = { ...process.env }
let fetchMock: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...ENV,
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Blend'n <hello@blendn.app>",
    RAILWAY_ENVIRONMENT_NAME: "staging",
  }
  delete process.env.EMAIL_ALLOWLIST
  fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "em_1" }) })
  global.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  process.env = ENV
})

const send = (to: string) => sendEmail({ to, subject: "s", text: "t" })

describe("outside production", () => {
  it("does not send to an outside address, and says it was not sent", async () => {
    const r = await send("x@toit.in")
    expect(fetchMock).not.toHaveBeenCalled()
    // The same "not sent" every caller already handles: notifyClaimant reports
    // emailSent false, an invite hands over its link.
    expect(r).toMatchObject({ sent: false, reason: "not_configured" })
  })

  it("does not send when there is no Railway environment at all (local)", async () => {
    delete process.env.RAILWAY_ENVIRONMENT_NAME
    await send("x@toit.in")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(["delivered+a@resend.dev", "admin@blendn.app", "A@MatrixSocialLabs.com"])(
    "sends to %s",
    async (to) => {
      const r = await send(to)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toEqual([to])
      expect(r.sent).toBe(true)
    }
  )

  it.each(["x@evil-blendn.app", "x@blendn.app.evil.com"])(
    "does not send to the lookalike %s — the domain matches exactly or not at all",
    async (to) => {
      const r = await send(to)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(r.sent).toBe(false)
    }
  )

  it("sends to an exact address listed in EMAIL_ALLOWLIST, trimmed and case-insensitive", async () => {
    process.env.EMAIL_ALLOWLIST = " Owner@Gmail.com , b@x.io"
    const r = await send("owner@gmail.com")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.sent).toBe(true)
  })

  it("does not open the domain of an EMAIL_ALLOWLIST address", async () => {
    process.env.EMAIL_ALLOWLIST = " Owner@Gmail.com , b@x.io"
    await send("someone.else@gmail.com")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("warns naming the domain, never the address", async () => {
    await send("priya.rao@toit.in")
    expect(mockWarn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(mockWarn.mock.calls)
    expect(logged).toContain("toit.in")
    expect(logged).not.toContain("priya.rao")
  })
})

describe("in production", () => {
  it("sends to any address", async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production"
    const r = await send("x@toit.in")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.sent).toBe(true)
    expect(mockWarn).not.toHaveBeenCalled()
  })
})
