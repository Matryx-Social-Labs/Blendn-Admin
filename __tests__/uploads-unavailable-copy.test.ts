/**
 * With storage down, a person is told uploads are not working, never why
 * (drive 2026-10-27: "File storage is not configured" in a phone's photo bubble).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { NextRequest } from "next/server"
import { UPLOADS_UNAVAILABLE } from "@/lib/tigris"

it("the mobile presign answers 503 with a sentence for a person", async () => {
  delete process.env.TIGRIS_ENDPOINT
  const { POST } = await import("@/app/api/mobile/uploads/presigned-url/route")
  const res = await POST(new NextRequest("http://localhost/api/mobile/uploads/presigned-url", { method: "POST", body: "{}" }))
  expect(res.status).toBe(503)
  const body = await res.json()
  expect(body.error).toBe(UPLOADS_UNAVAILABLE)
  expect(body.error).not.toMatch(/configur|storage|tigris/i)
})
