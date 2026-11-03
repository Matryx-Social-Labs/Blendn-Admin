import { createHmac, timingSafeEqual } from "node:crypto"

import { payBaseUrl, ticketPayKey } from "./env"

/**
 * The pay link's token (SCRUM-1011, contract §3).
 *
 * The app opens the pay page in Safari View Controller / a Custom Tab, which
 * has no JWT. The link carries `<expiry, unix s>.<base64url HMAC-SHA256>` over
 * the order id, its buyer and the expiry, so it opens one order, for the
 * person who made it, for fifteen minutes. The buyer id is not in the token:
 * the page reads it from the order and recomputes, so a token for one buyer's
 * order says nothing about any other.
 */

export const PAY_TOKEN_TTL_MS = 15 * 60_000

const mac = (orderId: string, buyerId: string, exp: number): Buffer =>
  createHmac("sha256", ticketPayKey()).update(`ticket-pay:v1:${orderId}:${buyerId}:${exp}`, "utf8").digest()

export function payTokenFor(orderId: string, buyerId: string, now: Date = new Date()): string {
  const exp = Math.floor((now.getTime() + PAY_TOKEN_TTL_MS) / 1000)
  return `${exp}.${mac(orderId, buyerId, exp).toString("base64url")}`
}

export type PayTokenCheck = "ok" | "expired" | "invalid"

/** Constant-time on the MAC; the expiry is only believed once the MAC says it is ours. Never throws on input. */
export function verifyPayToken(token: string | null | undefined, orderId: string, buyerId: string, now: Date = new Date(Date.now())): PayTokenCheck {
  const [expText, given, extra] = typeof token === "string" ? token.split(".") : []
  if (!expText || !given || extra !== undefined || !/^\d{1,12}$/.test(expText)) return "invalid"
  const exp = Number(expText)
  const presented = Buffer.from(given, "base64url")
  const expected = mac(orderId, buyerId, exp)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return "invalid"
  return now.getTime() > exp * 1000 ? "expired" : "ok"
}

/** `<PAY_BASE_URL>/pay/o/<orderId>?t=<token>`: what POST /ticket-orders returns. */
export function payUrlFor(orderId: string, buyerId: string, now: Date = new Date()): string {
  return `${payBaseUrl()}/pay/o/${orderId}?t=${encodeURIComponent(payTokenFor(orderId, buyerId, now))}`
}
