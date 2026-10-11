/*
 * Blendn+ and account erasure, through the real routes (step 11, review M2
 * and L8; test plan D-17).
 *
 * The race: a store purchase being granted while the person deletes their
 * account. The webhook's insert is slowed by a trigger so the erasure starts
 * inside it; whichever commits first, no Blendn+ row may outlive the account.
 */
import { randomUUID } from "crypto"
import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  ownedObjectKey: jest.requireActual("@/lib/tigris").ownedObjectKey,
  ownedPhotoKey: jest.requireActual("@/lib/tigris").ownedPhotoKey,
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
  sealedChatKey: jest.requireActual("@/lib/tigris").sealedChatKey,
  deleteFile: jest.fn().mockResolvedValue(undefined),
  deletePrefix: jest.fn().mockResolvedValue(0),
  isConfigured: () => true,
}))

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeUser } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
const webhook = require("@/app/api/webhooks/revenuecat/route") as typeof import("@/app/api/webhooks/revenuecat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = "rc_itest_erasure_secret_0123456789abcdef"
const T0 = Date.now() - 60 * 60 * 1000
const users: string[] = []

beforeAll(() => {
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET
  delete process.env.RAILWAY_ENVIRONMENT_NAME
})

afterEach(() => {
  jest.restoreAllMocks()
  delete process.env.REVENUECAT_SECRET_KEY
})

afterAll(async () => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET
  await db.payment_events.deleteMany({ where: { provider: "revenuecat", provider_event_id: { startsWith: "itest_rce_" } } })
  await db.entitlements.deleteMany({ where: { subject_kind: "user", subject_id: { in: users } } })
  await db.deleted_account_records.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function account() {
  const id = await makeUser("rce")
  users.push(id)
  await db.profiles.create({ data: { id, name: "Test", onboarded: true } })
  return id
}

async function deleteAccount(id: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return accountRoute.DELETE(
    new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${signAccessToken(id, email)}` } })
  )
}

function purchase(user: string, txn: string) {
  const body = JSON.stringify({
    api_version: "1.0",
    event: {
      id: `itest_rce_${randomUUID()}`,
      type: "INITIAL_PURCHASE",
      event_timestamp_ms: T0,
      app_user_id: user,
      product_id: "blendn_plus_monthly",
      entitlement_ids: ["plus"],
      purchased_at_ms: T0,
      expiration_at_ms: T0 + 30 * 86_400_000,
      environment: "SANDBOX",
      store: "APP_STORE",
      transaction_id: txn,
      original_transaction_id: txn,
    },
  })
  return webhook.POST(
    new NextRequest("http://localhost/api/webhooks/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, "x-real-ip": "203.0.113.30" },
      body,
    })
  )
}

it("leaves no Blendn+ row for an account erased while its purchase was being granted (review M2)", async () => {
  const id = await account()
  const txn = `itest_txn_${randomUUID().slice(0, 12)}`
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION itest_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.0); RETURN NEW; END $$`)
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS itest_slow ON entitlements`)
  await db.$executeRawUnsafe(`CREATE TRIGGER itest_slow BEFORE INSERT ON entitlements FOR EACH ROW WHEN (NEW.external_ref = '${txn}') EXECUTE FUNCTION itest_slow()`)
  try {
    const granting = purchase(id, txn)
    await new Promise((r) => setTimeout(r, 300))
    const erased = await deleteAccount(id)
    expect(erased.status).toBe(200)
    expect((await granting).status).toBe(200)
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS itest_slow ON entitlements`)
  }
  expect(await db.entitlements.count({ where: { subject_kind: "user", subject_id: id } })).toBe(0)
  // And a renewal after the erasure grants nothing.
  const renewal = await purchase(id, `itest_txn_${randomUUID().slice(0, 12)}`)
  expect(await renewal.json()).toMatchObject({ applied: false, refused: "unknown_user" })
})

it("deletes the person at RevenueCat too when the secret key is set, and a refusal there does not undo the erasure (review L8)", async () => {
  process.env.REVENUECAT_SECRET_KEY = "sk_itesterasure0123456789"
  const calls: string[] = []
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`)
    return new Response("{}", { status: calls.length === 1 ? 200 : 500 })
  })
  const first = await account()
  expect((await deleteAccount(first)).status).toBe(200)
  expect(calls).toEqual([`DELETE https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(first)}`])

  const second = await account()
  expect((await deleteAccount(second)).status).toBe(200)
  expect(calls).toHaveLength(2)
  expect((await db.user.findUniqueOrThrow({ where: { id: second } })).deletedAt).not.toBeNull()
})
