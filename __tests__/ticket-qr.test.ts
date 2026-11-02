jest.mock("@/lib/db", () => ({ db: {} }))

import { createHmac } from "node:crypto"

import { validateEnv } from "@/lib/env"
import { ticketQrPayload, verifyTicketQr } from "@/lib/tickets"

/**
 * A ticket's QR (SCRUM-1010): `<id>.<base64url HMAC-SHA256(TICKET_QR_KEY, id)>`,
 * derived on demand and stored nowhere, so a reinstall or a new phone gets the
 * same QR back. The tests carry their own key.
 */

const KEY = "unit-test-ticket-qr-key-0123456789abcdefghij"
const ID = "6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c"

let previous: NodeJS.ProcessEnv
beforeEach(() => {
  previous = { ...process.env }
  process.env.TICKET_QR_KEY = KEY
})
afterEach(() => {
  process.env = previous
})

describe("ticketQrPayload", () => {
  it("is the id and its HMAC-SHA256 under the key, base64url", () => {
    const mac = createHmac("sha256", KEY).update(ID).digest("base64url")
    expect(ticketQrPayload(ID)).toBe(`${ID}.${mac}`)
  })

  it("is the same every time it is asked for: nothing to lose with the phone", () => {
    expect(ticketQrPayload(ID)).toBe(ticketQrPayload(ID))
  })

  it("refuses to sign anything but a ticket id", () => {
    expect(() => ticketQrPayload("not-a-uuid")).toThrow(TypeError)
  })

  it("throws without a key, or with a short one, rather than signing with nothing", () => {
    delete process.env.TICKET_QR_KEY
    expect(() => ticketQrPayload(ID)).toThrow(/TICKET_QR_KEY/)
    process.env.TICKET_QR_KEY = "short"
    expect(() => ticketQrPayload(ID)).toThrow(/TICKET_QR_KEY/)
  })
})

describe("verifyTicketQr", () => {
  it("names the ticket a QR we signed", () => {
    expect(verifyTicketQr(ticketQrPayload(ID))).toBe(ID)
  })

  it("refuses one signed with another key", () => {
    const other = `${ID}.${createHmac("sha256", "someone-elses-key-0123456789abcdefghij").update(ID).digest("base64url")}`
    expect(verifyTicketQr(other)).toBeNull()
  })

  it("refuses another ticket's MAC on this id", () => {
    const [, mac] = ticketQrPayload("0b6a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b").split(".")
    expect(verifyTicketQr(`${ID}.${mac}`)).toBeNull()
  })

  it.each(["", "nope", `${ID}`, `${ID}.`, `${ID}.AAAA`, `x.${"A".repeat(43)}`, `${ID}.a.b`])("refuses %p", (payload) => {
    expect(verifyTicketQr(payload)).toBeNull()
  })
})

describe("TICKET_QR_KEY at boot", () => {
  const base = {
    DATABASE_URL: "postgresql://x",
    NEXTAUTH_URL: "http://localhost:3000",
    NEXTAUTH_SECRET: "n".repeat(32),
    MOBILE_JWT_SECRET: "m".repeat(32),
  }
  const boot = (extra: Record<string, string>) => {
    process.env = { ...base, ...extra } as unknown as NodeJS.ProcessEnv
    return validateEnv
  }

  it("is required once TICKETING is on", () => {
    expect(boot({ TICKETING: "true" })).toThrow(/Invalid environment variables/)
    // TICKET_PAY_KEY is required with it since Phase 2 (ticket-pay-token.test.ts holds that rule).
    expect(() => boot({ TICKETING: "true", TICKET_QR_KEY: KEY, TICKET_PAY_KEY: `${KEY}-pay` })()).not.toThrow()
  })

  it("is not asked for while TICKETING is off", () => {
    expect(() => boot({})()).not.toThrow()
    expect(() => boot({ TICKETING: "false" })()).not.toThrow()
  })

  it("is 32 characters or more when set", () => {
    expect(boot({ TICKET_QR_KEY: "short" })).toThrow(/Invalid environment variables/)
  })
})
