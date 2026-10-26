/**
 * API M6 follow-up: `size` stays optional only for app builds that predate
 * sending it. The dashboard route always requires it; the mobile route requires
 * it from `UPLOAD_SIZE_REQUIRED_FROM_VERSION` (the X-App-Version the 426 gate
 * already reads).
 */
import { NextRequest } from "next/server"

process.env.TIGRIS_ENDPOINT = "https://storage.test"
process.env.TIGRIS_ACCESS_KEY = "ak"
process.env.TIGRIS_SECRET_KEY = "sk"

jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: async () => ({ userId: "user-1" }) }))
jest.mock("@/lib/auth", () => ({ getAuth: async () => ({ user: { id: "staff-1", role: "organizer" } }) }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: async () => null, userLimit: () => ({}) }))
jest.mock("@/lib/db", () => ({ db: {} }))

import { POST as mobile } from "@/app/api/mobile/uploads/presigned-url/route"
import { POST as staff } from "@/app/api/uploads/presigned-url/route"
import { UPLOAD_SIZE_REQUIRED_FROM_VERSION, sendsUploadSize } from "@/lib/mobile-gate"

const call = (h: typeof mobile, body: unknown, version?: string) =>
  h(
    new NextRequest("http://localhost/x", {
      method: "POST",
      headers: version ? { "x-app-version": version } : {},
      body: JSON.stringify(body),
    })
  ).then((r) => r.status)

const photo = { filename: "a.jpg", contentType: "image/jpeg", folder: "profile" }

describe("mobile presigned-url", () => {
  it("requires size from a build that sends it", async () => {
    expect(await call(mobile, photo, UPLOAD_SIZE_REQUIRED_FROM_VERSION)).toBe(400)
    expect(await call(mobile, { ...photo, size: 100 }, UPLOAD_SIZE_REQUIRED_FROM_VERSION)).toBe(200)
  })
  it("keeps older builds, and requests with no version, working without it", async () => {
    expect(await call(mobile, photo, "1.0.0")).toBe(200)
    expect(await call(mobile, photo)).toBe(200)
  })
})

it("sendsUploadSize compares versions, not strings", () => {
  expect(sendsUploadSize("1.0.10")).toBe(true)
  expect(sendsUploadSize("1.0.0")).toBe(false)
  expect(sendsUploadSize("garbage")).toBe(false)
  expect(sendsUploadSize(null)).toBe(false)
})

describe("staff presigned-url", () => {
  const evt = { filename: "a.jpg", contentType: "image/jpeg", folder: "events" }
  it("always requires size", async () => {
    expect(await call(staff, evt)).toBe(400)
    expect(await call(staff, { ...evt, size: 100 })).toBe(200)
  })
  it("refuses a size above the folder ceiling", async () => {
    expect(await call(staff, { ...evt, size: 21 * 1024 * 1024 })).toBe(400)
  })
})
