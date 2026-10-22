import { plusGrantFrom, plusStateFrom, type StoreDelivery } from "@/lib/plus-state"

const now = new Date("2026-10-22T12:00:00Z")
const d = (type: string, extra: Partial<StoreDelivery> = {}): StoreDelivery => ({ type, cancelReason: null, graceExpiresAtMs: null, ...extra })

describe("plusStateFrom: only what the store said", () => {
  it("says nothing without a delivery", () => {
    expect(plusStateFrom(null, true, "apple", now)).toBeNull()
  })
  it.each(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "REFUND_REVERSED", "SUBSCRIPTION_EXTENDED", "NON_RENEWING_PURCHASE"])(
    "%s is active while live and expired once it is not",
    (type) => {
      expect(plusStateFrom(d(type), true, "apple", now)).toBe("active")
      expect(plusStateFrom(d(type), false, "apple", now)).toBe("expired")
    }
  )
  it("a cancellation is cancelled while access runs, expired after; a refund reason is refunded", () => {
    expect(plusStateFrom(d("CANCELLATION", { cancelReason: "UNSUBSCRIBE" }), true, "apple", now)).toBe("cancelled")
    expect(plusStateFrom(d("CANCELLATION", { cancelReason: "UNSUBSCRIBE" }), false, "apple", now)).toBe("expired")
    expect(plusStateFrom(d("CANCELLATION", { cancelReason: "CUSTOMER_SUPPORT" }), false, "apple", now)).toBe("refunded")
    expect(plusStateFrom(d("CANCELLATION", { cancelReason: "DEVELOPER_INITIATED" }), false, "google", now)).toBe("refunded")
  })
  it("a billing issue is grace only while the grace period is ahead", () => {
    const ahead = now.getTime() + 86_400_000
    expect(plusStateFrom(d("BILLING_ISSUE", { graceExpiresAtMs: ahead }), true, "apple", now)).toBe("grace")
    expect(plusStateFrom(d("BILLING_ISSUE", { graceExpiresAtMs: now.getTime() - 1 }), false, "apple", now)).toBeNull()
  })
  it("hold is Google's only: a billing issue with no grace period and no access", () => {
    expect(plusStateFrom(d("BILLING_ISSUE"), false, "google", now)).toBe("hold")
    expect(plusStateFrom(d("BILLING_ISSUE"), false, "apple", now)).toBeNull()
    expect(plusStateFrom(d("BILLING_ISSUE"), true, "google", now)).toBeNull()
  })
  it("paused and expired are what the store said", () => {
    expect(plusStateFrom(d("SUBSCRIPTION_PAUSED"), true, "google", now)).toBe("paused")
    expect(plusStateFrom(d("EXPIRATION"), false, "apple", now)).toBe("expired")
  })
  it("an event that says nothing about the purchase says nothing", () => {
    expect(plusStateFrom(d("TEST"), true, "apple", now)).toBeNull()
    expect(plusStateFrom(d("TRANSFER"), true, "apple", now)).toBeNull()
  })
})

describe("plusGrantFrom", () => {
  it("reads our two grant references and nothing else", () => {
    expect(plusGrantFrom("plus-trial:u1")).toBe("trial")
    expect(plusGrantFrom("plus-referral:u1:a+b+c")).toBe("referral")
    expect(plusGrantFrom("1000000123456")).toBeNull()
    expect(plusGrantFrom(null)).toBeNull()
  })
})
