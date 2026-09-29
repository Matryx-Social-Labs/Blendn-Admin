import { NextRequest } from "next/server"

import { middleware } from "@/middleware"

/*
 * A NUL byte in a mobile URL is refused before a route sees it (SCRUM-434).
 *
 * Postgres text cannot hold \u0000: `GET /api/mobile/events/search?q=%00`
 * reached the tsquery and answered 500 (22021, staging 2026-09-29 09:04:57Z),
 * and a cuid path parameter carrying one does the same. Nothing legitimate
 * sends a NUL, so the one place every mobile request passes refuses it.
 * Bodies are the other half: `lib/api-input.ts`, driven by
 * `__tests__/integration/bad-input-never-500.itest.ts`.
 */
const get = (path: string) => middleware(new NextRequest(`http://localhost${path}`))

describe("a NUL byte in a mobile URL", () => {
  it.each([
    "/api/mobile/events/search?q=%00",
    "/api/mobile/events/search?q=a%00b",
    "/api/mobile/users/%00",
    "/api/mobile/v1/events/search?q=%00",
  ])("%s is a 400 before any route runs", async (path) => {
    const res = await get(path)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, errorCode: "VALIDATION_FAILED" })
  })

  it("leaves an ordinary request alone", async () => {
    const res = await get("/api/mobile/events/search?q=jazz%20night")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })
})
