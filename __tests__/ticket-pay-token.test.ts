import { payTokenFor, payUrlFor, PAY_TOKEN_TTL_MS, verifyPayToken } from "@/lib/ticket-pay-token"
import { validateEnv } from "@/lib/env"

/**
 * The pay link's token (SCRUM-1011). The browser that opens the pay page has
 * no JWT, so the link carries `<expiry>.<HMAC(TICKET_PAY_KEY, order, buyer, expiry)>`:
 * fifteen minutes, one order, one buyer.
 */

const KEY = "unit-test-ticket-pay-key-0123456789abcdefghij"
const ORDER = "6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c"
const OTHER_ORDER = "7a2d3c9f-5d2b-4a8f-8b4c-3e6f9a1b2c3d"
const BUYER = "user-buyer-1"
const NOW = new Date("2026-11-03T10:00:00Z")

let previous: NodeJS.ProcessEnv
beforeEach(() => {
  previous = { ...process.env }
  process.env.TICKET_PAY_KEY = KEY
})
afterEach(() => {
  process.env = previous
})

describe("verifyPayToken", () => {
  it("accepts its own token for its order and buyer, until it expires", () => {
    const token = payTokenFor(ORDER, BUYER, NOW)
    expect(verifyPayToken(token, ORDER, BUYER, NOW)).toBe("ok")
    expect(verifyPayToken(token, ORDER, BUYER, new Date(NOW.getTime() + PAY_TOKEN_TTL_MS))).toBe("ok")
  })

  it("lasts fifteen minutes", () => {
    expect(PAY_TOKEN_TTL_MS).toBe(15 * 60_000)
  })

  it("is expired one second after", () => {
    const token = payTokenFor(ORDER, BUYER, NOW)
    expect(verifyPayToken(token, ORDER, BUYER, new Date(NOW.getTime() + PAY_TOKEN_TTL_MS + 1000))).toBe("expired")
  })

  it("is refused for another order, or another buyer", () => {
    const token = payTokenFor(ORDER, BUYER, NOW)
    expect(verifyPayToken(token, OTHER_ORDER, BUYER, NOW)).toBe("invalid")
    expect(verifyPayToken(token, ORDER, "user-someone-else", NOW)).toBe("invalid")
  })

  it("is refused when the expiry is moved: it is signed", () => {
    const token = payTokenFor(ORDER, BUYER, NOW)
    const [exp, mac] = token.split(".")
    expect(verifyPayToken(`${Number(exp) + 3600}.${mac}`, ORDER, BUYER, NOW)).toBe("invalid")
  })

  it("is refused when any character of the MAC changes", () => {
    const token = payTokenFor(ORDER, BUYER, NOW)
    const last = token.at(-1) === "A" ? "B" : "A"
    expect(verifyPayToken(`${token.slice(0, -1)}${last}`, ORDER, BUYER, NOW)).toBe("invalid")
  })

  it("is refused under another key", () => {
    const token = payTokenFor(ORDER, BUYER, NOW)
    process.env.TICKET_PAY_KEY = `${KEY}-rotated`
    expect(verifyPayToken(token, ORDER, BUYER, NOW)).toBe("invalid")
  })

  it.each([[""], ["garbage"], ["1.2.3"], ["abc.def"], [null], [undefined], ["-5.AAAA"]])("refuses %p without throwing", (token) => {
    expect(verifyPayToken(token as string, ORDER, BUYER, NOW)).toBe("invalid")
  })

  it("throws without a key rather than signing with nothing", () => {
    delete process.env.TICKET_PAY_KEY
    expect(() => payTokenFor(ORDER, BUYER, NOW)).toThrow(/TICKET_PAY_KEY/)
  })
})

describe("payUrlFor", () => {
  it("is PAY_BASE_URL/pay/o/<order>?t=<token>", () => {
    process.env.PAY_BASE_URL = "https://pay.blendn.app/"
    const url = new URL(payUrlFor(ORDER, BUYER, NOW))
    expect(`${url.origin}${url.pathname}`).toBe(`https://pay.blendn.app/pay/o/${ORDER}`)
    expect(verifyPayToken(url.searchParams.get("t"), ORDER, BUYER, NOW)).toBe("ok")
  })

  it("falls back to NEXTAUTH_URL", () => {
    delete process.env.PAY_BASE_URL
    process.env.NEXTAUTH_URL = "https://staging.example.com"
    expect(payUrlFor(ORDER, BUYER, NOW).startsWith(`https://staging.example.com/pay/o/${ORDER}?t=`)).toBe(true)
  })
})

describe("env", () => {
  const base = {
    DATABASE_URL: "postgresql://x/y",
    NEXTAUTH_URL: "http://localhost:3000",
    NEXTAUTH_SECRET: "x".repeat(32),
    MOBILE_JWT_SECRET: "y".repeat(32),
  }
  it("requires TICKET_PAY_KEY once TICKETING is on", () => {
    process.env = { ...base, TICKETING: "true", TICKET_QR_KEY: "q".repeat(32) } as unknown as NodeJS.ProcessEnv
    expect(() => validateEnv()).toThrow()
    process.env.TICKET_PAY_KEY = KEY
    expect(() => validateEnv()).not.toThrow()
  })
})
