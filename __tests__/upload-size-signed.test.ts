/**
 * API M6 (security audit): a presigned upload URL signed only `content-type`,
 * so one grant could write any number of bytes to the public bucket. A client
 * that declares its `size` gets a URL with `content-length` signed in; a
 * declaration above the folder's ceiling is refused before any URL exists.
 */
import { NextRequest } from "next/server"

process.env.TIGRIS_ENDPOINT = "https://storage.test"
process.env.TIGRIS_ACCESS_KEY = "ak"
process.env.TIGRIS_SECRET_KEY = "sk"

jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: async () => ({ userId: "user-1" }) }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: async () => null, userLimit: () => ({}) }))
jest.mock("@/lib/db", () => ({ db: {} }))

import { getPresignedUploadUrl, getMaxFileSize } from "@/lib/tigris"
import { POST } from "@/app/api/mobile/uploads/presigned-url/route"

const signedHeaders = (url: string) => new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? ""

describe("presigned upload size", () => {
  it("signs content-length when the client declares a size", async () => {
    const { uploadUrl } = await getPresignedUploadUrl("a.jpg", "image/jpeg", "profile", "user-1", { size: 12345 })
    expect(signedHeaders(uploadUrl).split(";")).toContain("content-length")
  })

  it("still signs content-type", async () => {
    const { uploadUrl } = await getPresignedUploadUrl("a.jpg", "image/jpeg", "profile", "user-1", { size: 12345 })
    expect(signedHeaders(uploadUrl).split(";")).toContain("content-type")
  })

  const ask = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/mobile/uploads/presigned-url", { method: "POST", body: JSON.stringify(body) }))

  it("issues a content-length-bound URL through the route", async () => {
    const res = await ask({ filename: "a.jpg", contentType: "image/jpeg", folder: "profile", size: 5000 })
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(signedHeaders(data.uploadUrl).split(";")).toContain("content-length")
  })

  it("refuses a declared size above the folder ceiling", async () => {
    const size = getMaxFileSize("profile") + 1
    const res = await ask({ filename: "a.jpg", contentType: "image/jpeg", folder: "profile", size })
    expect(res.status).toBe(400)
  })
})
