import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { isUuid } from "@/lib/api-input"
import { db } from "@/lib/db"
import { razorpayKeys, ticketingOn } from "@/lib/env"
import { verifyPayToken } from "@/lib/ticket-pay-token"

import { PayCheckout, PayShell, type PayOrder } from "./pay-checkout"

/**
 * The hosted pay page (SCRUM-1011, contract §3–4): `pay.blendn.app/pay/o/<orderId>?t=<token>`,
 * opened by the app in Safari View Controller / a Custom Tab, where there is
 * no JWT. The token (lib/ticket-pay-token.ts) is checked against the order's
 * own buyer before anything about the order is drawn.
 *
 * It shows the order as the server holds it, the hold's clock, the refund
 * line, and Razorpay Standard Checkout, which offers UPI, cards and
 * netbanking in India, and Apple Pay where Razorpay has it enabled for the
 * account. It never marks anything paid: the signed webhook does, and the
 * page waits for it (`./status`). Design: the ticketing board's checkout
 * hand-off frames (ember world, the gradient only on the one primary button).
 *
 * No indexing, no referrer (the token is in the URL), no caching: the
 * headers are next.config.ts's `/pay/:path*` block and the metadata below.
 */

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: { absolute: "Pay · Blend’n" }, robots: { index: false, follow: false }, referrer: "no-referrer" }

const POLICY_LINE: Record<string, string> = {
  none: "No refunds, unless the event is cancelled: then you get everything back, booking fee included.",
  until_7d: "Refundable until 7 days before the event (the booking fee is not). If the event is cancelled you get everything back.",
  until_24h: "Refundable until 24 hours before the event (the booking fee is not). If the event is cancelled you get everything back.",
}

/** When this request drew the page: the server's clock, which the hold is on. A request, not a render: never re-run on the client. */
const drawnAt = () => Date.now()

function when(start: Date, timeZone: string | null): string {
  const format = (tz?: string) =>
    new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz }).format(start)
  try {
    return format(timeZone ?? undefined)
  } catch {
    return format("UTC")
  }
}

export default async function PayPage({ params, searchParams }: { params: Promise<{ orderId: string }>; searchParams: Promise<{ t?: string | string[] }> }) {
  if (!ticketingOn()) notFound()
  const { orderId } = await params
  if (!isUuid(orderId)) notFound()
  const order = await db.ticket_orders.findUnique({
    where: { id: orderId },
    select: {
      buyer_id: true,
      status: true,
      hold_expires_at: true,
      provider_order_ref: true,
      payment_failed_at: true,
      currency: true,
      subtotal_minor: true,
      service_fee_minor: true,
      service_fee_tax_minor: true,
      processing_fee_minor: true,
      total_minor: true,
      fees_absorbed: true,
      lines: { select: { quantity: true, unit_price_minor: true, ticket_type: { select: { name: true, sort: true } } } },
      event: { select: { title: true, start_time: true, timezone: true, refund_policy: true, ticket_fee_schedule: true } },
    },
  })
  if (!order) notFound()
  const t = typeof (await searchParams).t === "string" ? ((await searchParams).t as string) : null
  const check = verifyPayToken(t, orderId, order.buyer_id)
  if (check !== "ok") {
    return (
      <PayShell>
        <h1 className="text-[24px] font-bold leading-[30px] tracking-[-0.4px]">{check === "expired" ? "This pay link has expired" : "This pay link isn’t valid"}</h1>
        <p className="mt-2 text-[15px] leading-[22px] text-[#B3AEAD]">Go back to Blend’n and tap Pay again for a fresh link. Nothing was charged.</p>
        <a href={`blendn://ticket/${orderId}`} className="mt-6 flex h-14 items-center justify-center rounded-full bg-[#242121] text-[16px] font-bold">
          Return to Blend’n
        </a>
      </PayShell>
    )
  }

  const market = (order.event.ticket_fee_schedule as { market?: string } | null)?.market
  const taxLabel = market ? ((await db.markets.findUnique({ where: { code: market }, select: { ticket_tax_label: true } }))?.ticket_tax_label ?? "Tax") : "Tax"
  const lines = [...order.lines].sort((a, b) => a.ticket_type.sort - b.ticket_type.sort)
  const view: PayOrder = {
    orderId,
    token: t!,
    status: order.status,
    paymentFailed: order.status === "pending" && order.payment_failed_at !== null,
    holdExpiresAt: order.hold_expires_at.toISOString(),
    serverNow: drawnAt(),
    providerOrderRef: order.provider_order_ref,
    keyId: razorpayKeys()?.keyId ?? null,
    currency: order.currency,
    eventTitle: order.event.title,
    when: when(order.event.start_time, order.event.timezone),
    lines: lines.map((l) => ({ name: l.ticket_type.name, quantity: l.quantity, unitMinor: l.unit_price_minor })),
    seats: lines.reduce((n, l) => n + l.quantity, 0),
    subtotalMinor: order.subtotal_minor,
    feesAbsorbed: order.fees_absorbed,
    fee: { serviceMinor: order.service_fee_minor, taxMinor: order.service_fee_tax_minor, processingMinor: order.processing_fee_minor, taxLabel },
    totalMinor: order.total_minor,
    refundLine: POLICY_LINE[order.event.refund_policy] ?? POLICY_LINE.none,
  }
  return (
    <PayShell>
      <PayCheckout order={view} />
    </PayShell>
  )
}
