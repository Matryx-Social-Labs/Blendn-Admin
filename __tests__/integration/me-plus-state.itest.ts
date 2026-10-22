/*
 * `GET /me/plus` says where a subscription stands, and which free month a grant
 * is, from real RevenueCat deliveries through the real webhook route (WP6).
 * Omitted when unknown.
 */
import { randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { trialRef } from "@/lib/plus"
import { cleanup, closeDb, db, makeUser } from "./helpers"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
/* eslint-disable @typescript-eslint/no-require-imports */
const webhook = require("@/app/api/webhooks/revenuecat/route") as typeof import("@/app/api/webhooks/revenuecat/route")
const mePlus = require("@/app/api/mobile/me/plus/route") as typeof import("@/app/api/mobile/me/plus/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "rc_itest_webhook_secret_0123456789abcdef"
const T0 = Date.now() - 3 * 60 * 60 * 1000
const MIN = 60_000
const DAY = 86_400_000
const users: string[] = []

beforeAll(() => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET
  delete process.env.RAILWAY_ENVIRONMENT_NAME
})
afterAll(async () => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET
  await db.payment_events.deleteMany({ where: { provider: "revenuecat", provider_event_id: { startsWith: "itest_mps_" } } })
  await db.entitlements.deleteMany({ where: { subject_kind: "user", subject_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email), txn: `itest_mps_txn_${randomUUID().slice(0, 10)}` }
}

type Who = Awaited<ReturnType<typeof person>>
let tick = 0
/** One delivery about `who`'s subscription, each later than the last. */
async function deliver(who: Who, type: string, o: { expires?: number; cancelReason?: string; grace?: number; store?: string } = {}) {
  const at = T0 + ++tick * MIN
  const body = {
    api_version: "1.0",
    event: {
      id: `itest_mps_${randomUUID()}`,
      type,
      event_timestamp_ms: at,
      app_user_id: who.id,
      product_id: "blendn_plus_monthly",
      entitlement_ids: ["plus"],
      period_type: "NORMAL",
      purchased_at_ms: T0,
      expiration_at_ms: o.expires ?? Date.now() + 20 * DAY,
      ...(o.grace !== undefined ? { grace_period_expiration_at_ms: o.grace } : {}),
      environment: "SANDBOX",
      store: o.store ?? "APP_STORE",
      transaction_id: who.txn,
      original_transaction_id: who.txn,
      ...(o.cancelReason ? { cancel_reason: o.cancelReason } : {}),
    },
  }
  const res = await webhook.POST(
    new NextRequest("http://localhost/api/webhooks/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, "x-real-ip": "203.0.113.31" },
      body: JSON.stringify(body),
    })
  )
  expect(res.status).toBe(200)
}

async function read(who: Who) {
  const res = await mePlus.GET(new NextRequest("http://localhost/api/mobile/me/plus", { headers: { authorization: `Bearer ${who.token}` } }))
  expect(res.status).toBe(200)
  return (await res.json()).data as Record<string, unknown>
}

it("a live subscription is active, with no grant", async () => {
  const p = await person("mps-active")
  await deliver(p, "INITIAL_PURCHASE")
  const body = await read(p)
  expect(body).toMatchObject({ active: true, source: "apple", state: "active" })
  expect(body).not.toHaveProperty("grant")
})

it("a cancellation keeps access and says cancelled; an uncancellation says active again", async () => {
  const p = await person("mps-cancel")
  await deliver(p, "INITIAL_PURCHASE")
  await deliver(p, "CANCELLATION", { cancelReason: "UNSUBSCRIBE" })
  expect(await read(p)).toMatchObject({ active: true, state: "cancelled" })
  await deliver(p, "UNCANCELLATION")
  expect(await read(p)).toMatchObject({ active: true, state: "active" })
})

it("a billing issue inside its grace period says grace", async () => {
  const p = await person("mps-grace")
  await deliver(p, "INITIAL_PURCHASE")
  await deliver(p, "BILLING_ISSUE", { grace: Date.now() + 2 * DAY })
  expect(await read(p)).toMatchObject({ active: true, state: "grace" })
})

it("Google's billing issue with no grace period and no access says hold", async () => {
  const p = await person("mps-hold")
  await deliver(p, "INITIAL_PURCHASE", { store: "PLAY_STORE" })
  await deliver(p, "BILLING_ISSUE", { store: "PLAY_STORE", expires: Date.now() - 2 * MIN })
  expect(await read(p)).toMatchObject({ active: false, source: null, state: "hold" })
})

it("a pause says paused", async () => {
  const p = await person("mps-paused")
  await deliver(p, "INITIAL_PURCHASE", { store: "PLAY_STORE" })
  await deliver(p, "SUBSCRIPTION_PAUSED", { store: "PLAY_STORE" })
  expect(await read(p)).toMatchObject({ state: "paused" })
})

it("an expiration says expired to somebody with nothing live", async () => {
  const p = await person("mps-expired")
  await deliver(p, "INITIAL_PURCHASE")
  await deliver(p, "EXPIRATION", { expires: Date.now() - MIN })
  expect(await read(p)).toMatchObject({ active: false, state: "expired" })
})

it("a store refund says refunded", async () => {
  const p = await person("mps-refund")
  await deliver(p, "INITIAL_PURCHASE")
  await deliver(p, "CANCELLATION", { cancelReason: "CUSTOMER_SUPPORT" })
  expect(await read(p)).toMatchObject({ active: false, state: "refunded" })
})

it("our trial and a referral month say grant, never state", async () => {
  const trial = await person("mps-trial")
  await db.entitlements.create({
    data: { subject_kind: "user", subject_id: trial.id, product: "plus", source: "grant", external_ref: trialRef(trial.id), starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + 5 * DAY) },
  })
  const t = await read(trial)
  expect(t).toMatchObject({ active: true, source: "grant", grant: "trial" })
  expect(t).not.toHaveProperty("state")

  const ref = await person("mps-referral")
  await db.entitlements.create({
    data: { subject_kind: "user", subject_id: ref.id, product: "plus", source: "grant", external_ref: `plus-referral:${ref.id}:a+b+c`, starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + 5 * DAY) },
  })
  expect(await read(ref)).toMatchObject({ grant: "referral" })
})

it("nobody with no purchase gets either field; a grant row with no known ref says neither", async () => {
  const none = await person("mps-none")
  const body = await read(none)
  expect(body).toMatchObject({ active: false, product: null })
  expect(body).not.toHaveProperty("state")
  expect(body).not.toHaveProperty("grant")

  const manual = await person("mps-manual")
  await db.entitlements.create({
    data: { subject_kind: "user", subject_id: manual.id, product: "plus", source: "grant", external_ref: null, starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + DAY) },
  })
  const m = await read(manual)
  expect(m).toMatchObject({ active: true, source: "grant" })
  expect(m).not.toHaveProperty("state")
  expect(m).not.toHaveProperty("grant")
})

it("a store row the webhook did not write has no state to report", async () => {
  const p = await person("mps-orphan")
  await db.entitlements.create({
    data: { subject_kind: "user", subject_id: p.id, product: "plus", source: "apple", external_ref: `itest_mps_txn_${randomUUID().slice(0, 8)}`, starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + DAY) },
  })
  const body = await read(p)
  expect(body).toMatchObject({ active: true, source: "apple" })
  expect(body).not.toHaveProperty("state")
})
