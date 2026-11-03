import { createHmac, randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { feeScheduleFromMarket, type MarketFeeRow } from "@/lib/ticket-fees"
import { reserveTickets } from "@/lib/ticket-holds"

import { cleanup, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/**
 * The ticketing world for the Phase 2 suites (SCRUM-1011): an organisation
 * with a Route linked account, a native-ticketed event in India, buyers, and
 * a fake Razorpay behind `fetch`.
 *
 * No Razorpay test keys exist on this machine, so Razorpay is this fake: it
 * keeps orders, payments, refunds, transfers and reversals the way the API
 * answers them, records every call, and can be told to fail one. Deliveries
 * go through the real webhook route with a real signature.
 */

export const WEBHOOK_SECRET = "whsec_itest_tickets_webhook_secret_0123456789"
export const LINKED_ACCOUNT = "acc_ITESTLINKED001"

export function ticketEnv() {
  const previous = { ...process.env }
  Object.assign(process.env, {
    TICKETING: "true",
    TICKET_QR_KEY: "itest-ticket-qr-key-0123456789abcdefghijkl",
    TICKET_PAY_KEY: "itest-ticket-pay-key-0123456789abcdefghijk",
    PAY_BASE_URL: "https://pay.itest.invalid",
    RAZORPAY_KEY_ID: "rzp_test_itesttickets",
    RAZORPAY_KEY_SECRET: "itest_razorpay_key_secret_01",
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    MOBILE_JWT_SECRET: process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij",
  })
  return () => {
    process.env = previous
  }
}

/* ------------------------------------------------------------------------ */
/* Fake Razorpay                                                             */
/* ------------------------------------------------------------------------ */

type Payment = { id: string; order_id: string; amount: number; currency: string; status: string; created_at: number }
type Refund = { id: string; payment_id: string; amount: number; currency: string; status: string }
type Transfer = { id: string; recipient: string; amount: number; currency: string; on_hold_until?: number }

export interface FakeRazorpay {
  calls: Array<{ method: string; path: string; body: unknown }>
  orders: Map<string, { amount: number; currency: string; receipt: string }>
  payments: Map<string, Payment[]>
  refunds: Map<string, Refund[]>
  transfers: Map<string, Transfer[]>
  reversals: Array<{ transfer_id: string; amount: number }>
  /** Path prefixes ("POST /orders") that answer 500 once, then work. */
  failOnce: Set<string>
  /** A captured payment on a Razorpay order, as if the buyer paid: what Checkout does. */
  capture(orderRef: string, amount?: number): Payment
  /** Milliseconds to hold one call before answering, to make races real. */
  delay: (method: string, path: string, body: unknown) => number
  /** Every transfer, by id. */
  transfer(id: string): Transfer | undefined
}

export function fakeRazorpay(): FakeRazorpay {
  const real = global.fetch
  const fake: FakeRazorpay = {
    calls: [],
    orders: new Map(),
    payments: new Map(),
    refunds: new Map(),
    transfers: new Map(),
    reversals: [],
    failOnce: new Set(),
    delay: () => 0,
    transfer: (id) => [...fake.transfers.values()].flat().find((t) => t.id === id),
    capture(orderRef, amount) {
      const order = fake.orders.get(orderRef)
      if (!order) throw new Error(`no fake order ${orderRef}`)
      const payment = { id: `pay_${randomUUID().slice(0, 14)}`, order_id: orderRef, amount: amount ?? order.amount, currency: order.currency, status: "captured", created_at: Math.floor(Date.now() / 1000) - 5 }
      fake.payments.set(orderRef, [...(fake.payments.get(orderRef) ?? []), payment])
      return payment
    },
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    if (!url.startsWith("https://api.razorpay.com/v1")) return real(input, init)
    const method = init?.method ?? "GET"
    const path = url.slice("https://api.razorpay.com/v1".length)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    fake.calls.push({ method, path, body })
    const wait = fake.delay(method, path, body)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const key = [...fake.failOnce].find((k) => `${method} ${path}`.startsWith(k))
    if (key) {
      fake.failOnce.delete(key)
      return json({ error: { description: "fake outage" } }, 500)
    }

    let m: RegExpMatchArray | null
    if (method === "POST" && path === "/orders") {
      const id = `order_${randomUUID().slice(0, 14)}`
      fake.orders.set(id, { amount: body.amount, currency: body.currency, receipt: body.receipt })
      return json({ id, amount: body.amount, currency: body.currency, status: "created" })
    }
    if ((m = path.match(/^\/orders\/([^/]+)\/payments$/))) return json({ items: fake.payments.get(decodeURIComponent(m[1])) ?? [] })
    if ((m = path.match(/^\/payments\/([^/]+)\/refunds$/))) return json({ items: fake.refunds.get(m[1]) ?? [] })
    if ((m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
      const refund = { id: `rfnd_${randomUUID().slice(0, 14)}`, payment_id: m[1], amount: body.amount, currency: "INR", status: "processed" }
      fake.refunds.set(m[1], [...(fake.refunds.get(m[1]) ?? []), refund])
      return json(refund)
    }
    if ((m = path.match(/^\/payments\/([^/]+)\/transfers$/))) {
      if (method === "GET") return json({ items: fake.transfers.get(m[1]) ?? [] })
      const t = body.transfers[0]
      const transfer = { id: `trf_${randomUUID().slice(0, 14)}`, recipient: t.account, amount: t.amount, currency: t.currency, on_hold_until: t.on_hold_until }
      fake.transfers.set(m[1], [...(fake.transfers.get(m[1]) ?? []), transfer])
      return json({ entity: "collection", count: 1, items: [transfer] })
    }
    if (method === "GET" && (m = path.match(/^\/transfers\/([^/]+)$/))) {
      const t = fake.transfer(m[1])
      return t ? json({ ...t, entity: "transfer", on_hold: true }) : json({ error: { description: "The id provided does not exist" } }, 400)
    }
    if (method === "PATCH" && (m = path.match(/^\/transfers\/([^/]+)$/))) {
      // Modify settlement hold (Route): PATCH /v1/transfers/:id { on_hold, on_hold_until }.
      for (const list of fake.transfers.values()) {
        const t = list.find((x) => x.id === m![1])
        if (t) {
          t.on_hold_until = body.on_hold_until
          return json({ ...t, entity: "transfer", on_hold: body.on_hold, settlement_status: "on_hold" })
        }
      }
      return json({ error: { description: "The id provided does not exist" } }, 400)
    }
    if ((m = path.match(/^\/transfers\/([^/]+)\/reversals$/))) {
      fake.reversals.push({ transfer_id: m[1], amount: body.amount })
      return json({ id: `rvrsl_${randomUUID().slice(0, 14)}`, transfer_id: m[1], amount: body.amount })
    }
    return json({ error: { description: `fake has no ${method} ${path}` } }, 404)
  })
  return fake
}

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

export interface World {
  users: string[]
  events: string[]
  orgs: string[]
}

export const newWorld = (): World => ({ users: [], events: [], orgs: [] })

export async function teardown(w: World) {
  const where = { event_id: { in: w.events } }
  await db.payment_events.deleteMany({ where: { provider_event_id: { startsWith: "itest_tix_" } } })
  await db.ticket_payouts.deleteMany({ where: { order: where } })
  await db.tickets.deleteMany({ where })
  await db.ticket_order_lines.deleteMany({ where })
  await db.ticket_orders.deleteMany({ where })
  await db.ticket_types.deleteMany({ where })
  await db.notifications.deleteMany({ where: { user_id: { in: w.users } } })
  await db.audit_logs.deleteMany({ where: { OR: [{ org_id: { in: w.orgs } }, { user_id: { in: w.users } }] } })
  await cleanup(w.users, w.events)
  await db.organisation_members.deleteMany({ where: { org_id: { in: w.orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: w.orgs } } })
}

export async function india() {
  const row = await db.markets.findUniqueOrThrow({ where: { code: "IN" } })
  return feeScheduleFromMarket(row as MarketFeeRow, new Date())
}

type TypeSpec = { quantity: number; price?: number; hidden?: boolean; sold?: number; startsAt?: Date | null; endsAt?: Date | null; max?: number }

/** An org (owner = host, with a linked account unless told otherwise) and its published native-ticketed event. */
export async function ticketedEvent(
  w: World,
  types: TypeSpec[],
  opts: { account?: string | null; accountStatus?: "not_started" | "pending" | "active" | "rejected"; absorbed?: boolean } = {}
) {
  const host = await makeUser(testId("tix-host"), "organizer")
  w.users.push(host)
  const account = opts.account === undefined ? LINKED_ACCOUNT : opts.account
  const org = await db.organisations.create({
    data: {
      kind: "company",
      display_name: testId("tix-org"),
      status: "verified",
      razorpay_account_id: account,
      razorpay_account_status: opts.accountStatus ?? (account ? "active" : "not_started"),
    },
  })
  w.orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  const eventId = await makeEvent(host)
  w.events.push(eventId)
  const endTime = new Date(Date.now() + 2 * 86_400_000)
  await db.events.update({
    where: { id: eventId },
    data: {
      organizer_org_id: org.id,
      ticketing_mode: "native",
      ticket_fee_schedule: await india(),
      ticketing_enabled_at: new Date(),
      ticket_fee_rule: "standard",
      fees_absorbed: opts.absorbed ?? false,
      end_time: endTime,
    },
  })
  const ids: string[] = []
  for (const [i, t] of types.entries()) {
    const row = await db.ticket_types.create({
      data: {
        event_id: eventId,
        name: `Tier ${i}`,
        price_minor: t.price ?? 49_900,
        quantity: t.quantity,
        sold: t.sold ?? 0,
        hidden: t.hidden ?? false,
        sale_starts_at: t.startsAt ?? null,
        sale_ends_at: t.endsAt ?? null,
        max_per_order: t.max ?? 10,
        sort: i,
      },
      select: { id: true },
    })
    ids.push(row.id)
  }
  return { host, orgId: org.id, eventId, typeIds: ids, endTime }
}

export async function buyer(w: World) {
  const id = await makeUser(testId("tix-buyer"))
  await onboard(id)
  w.users.push(id)
  return id
}

/** A held order with its Razorpay order, as POST /ticket-orders leaves it. */
export async function heldOrder(fake: FakeRazorpay, eventId: string, buyerId: string, lines: Array<{ ticketTypeId: string; quantity: number }>) {
  const held = await reserveTickets({ eventId, buyerId, lines })
  if (!held.ok) throw new Error(`setup refused: ${held.reason}`)
  const order = await db.ticket_orders.findUniqueOrThrow({ where: { id: held.orderId }, select: { total_minor: true, currency: true } })
  const res = await global.fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    body: JSON.stringify({ amount: order.total_minor, currency: order.currency, receipt: held.orderId }),
  })
  const { id: orderRef } = (await res.json()) as { id: string }
  await db.ticket_orders.update({ where: { id: held.orderId }, data: { provider_order_ref: orderRef } })
  fake.calls.length = 0
  return { orderId: held.orderId, orderRef, totalMinor: order.total_minor }
}

/** The hold ran out: the clock is the server's, so the row is moved, not the clock. */
export const lapse = (orderId: string) =>
  db.ticket_orders.update({ where: { id: orderId }, data: { hold_expires_at: new Date(Date.now() - 20 * 60_000) } })

/* ------------------------------------------------------------------------ */
/* Deliveries                                                                */
/* ------------------------------------------------------------------------ */

export function capturedDelivery(type: "payment.captured" | "order.paid", payment: { id: string; order_id: string; amount: number; currency: string; created_at: number }) {
  const at = Math.floor(Date.now() / 1000)
  return {
    entity: "event",
    event: type,
    payload: {
      payment: { entity: { ...payment, status: "captured", email: "payer@example.com", contact: "+919999999999" } },
      ...(type === "order.paid" ? { order: { entity: { id: payment.order_id, amount: payment.amount, amount_paid: payment.amount, currency: payment.currency, status: "paid" } } } : {}),
    },
    created_at: at,
  }
}

export function refundDelivery(refund: { id: string; payment_id: string; amount: number }) {
  return { entity: "event", event: "refund.processed", payload: { refund: { entity: { ...refund, currency: "INR", status: "processed" } } }, created_at: Math.floor(Date.now() / 1000) }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const webhook = () => require("@/app/api/webhooks/razorpay/route") as typeof import("@/app/api/webhooks/razorpay/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/** Through the real route, signed as Razorpay signs: HMAC-SHA256 of the raw body. */
export async function deliver(body: unknown, eventId = `itest_tix_${randomUUID()}`, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(body)
  const signature = createHmac("sha256", secret).update(raw).digest("hex")
  const res = await webhook().POST(
    new NextRequest("http://localhost/api/webhooks/razorpay", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId },
    })
  )
  return { status: res.status, body: (await res.json()) as { ok?: boolean; duplicate?: boolean; applied?: boolean; refused?: string } }
}

/** The after-commit calls run inside the route's request; give a straggler a tick. */
export const settled = () => new Promise((r) => setTimeout(r, 20))

export const typeRow = (id: string) => db.ticket_types.findUniqueOrThrow({ where: { id }, select: { sold: true, held: true, quantity: true } })
export const orderRow = (id: string) =>
  db.ticket_orders.findUniqueOrThrow({
    where: { id },
    select: { status: true, provider_payment_ref: true, refund_requested_minor: true, refund_reason: true, refunded_minor: true, provider_refund_ref: true, _count: { select: { tickets: true } } },
  })
