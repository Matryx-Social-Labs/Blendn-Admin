/*
 * The mobile gate, driven through the real request chain (Flow 15, SCRUM-746).
 *
 * `mobile-gate.test.ts` calls the middleware function and checks what it
 * returns. This drives what Next does with it: the matcher decides whether the
 * middleware runs at all, a refusal ends the request there, and anything the
 * middleware lets through reaches the REAL route handler -- the health check on
 * a real database, a real mobile route answering an anonymous caller. What the
 * unit file cannot say is that a route behind the gate is still the route it
 * was, and that the healthcheck Railway deploys on is untouched by maintenance.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { NextRequest } from "next/server"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"

import { config, middleware } from "@/middleware"
import { closeDb } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const healthRoute = require("@/app/api/health/route") as typeof import("@/app/api/health/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")

const VARIABLES = ["MOBILE_MIN_APP_VERSION", "MAINTENANCE_MODE", "MAINTENANCE_RETRY_AFTER_SECONDS", "MOBILE_MIN_APP_BUILD_IOS", "MOBILE_MIN_APP_BUILD_ANDROID"] as const
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]))
afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})
afterAll(closeDb)

/** What a client gets for `GET path`: the middleware if the matcher names the path, then the real handler. */
async function get(path: string, headers: Record<string, string> = {}): Promise<{ res: Response; reachedRoute: boolean }> {
  const url = `http://localhost${path}`
  const handlerFor = (pathname: string) =>
    pathname === "/api/health" ? () => healthRoute.GET() : () => eventsRoute.GET(new NextRequest(url, { headers }))
  if (unstable_doesMiddlewareMatch({ config, url })) {
    const res = await middleware(new NextRequest(url, { headers }))
    const continued = res.headers.get("x-middleware-next") === "1" || res.headers.has("x-middleware-rewrite")
    if (!continued) return { res, reachedRoute: false }
  }
  return { res: await handlerFor(new URL(url).pathname)(), reachedRoute: true }
}

describe("maintenance (MAINTENANCE_MODE)", () => {
  beforeEach(() => {
    process.env.MAINTENANCE_MODE = "1"
    process.env.MAINTENANCE_RETRY_AFTER_SECONDS = "120"
  })

  it("answers a mobile request 503 MAINTENANCE with Retry-After, and never reaches the route", async () => {
    const { res, reachedRoute } = await get("/api/mobile/events", { "x-app-version": "1.0.0" })
    expect(reachedRoute).toBe(false)
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("120")
    expect(await res.json()).toMatchObject({ success: false, errorCode: "MAINTENANCE", retryAfter: 120 })
  })

  it("leaves /api/health answering from the real database: the deploy's healthcheck must not fail", async () => {
    const { res, reachedRoute } = await get("/api/health")
    expect(reachedRoute).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok", database: "connected" })
  })

  it("leaves the dashboard to its own sign-in, not a 503", async () => {
    const { res } = await get("/dashboard")
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
  })

  it("lets the same mobile route answer for itself once maintenance is off", async () => {
    delete process.env.MAINTENANCE_MODE
    const { res, reachedRoute } = await get("/api/mobile/events")
    expect(reachedRoute).toBe(true)
    // The route's own answer to a caller with no token -- not the gate's.
    expect(res.status).toBe(401)
  })
})

describe("the minimum app version (MOBILE_MIN_APP_VERSION)", () => {
  beforeEach(() => {
    process.env.MOBILE_MIN_APP_VERSION = "1.0.1"
  })

  it("answers a build below the minimum 426 UPDATE_REQUIRED, and never reaches the route", async () => {
    const { res, reachedRoute } = await get("/api/mobile/events", { "x-app-version": "1.0.0" })
    expect(reachedRoute).toBe(false)
    expect(res.status).toBe(426)
    expect(await res.json()).toMatchObject({ success: false, errorCode: "UPDATE_REQUIRED" })
  })

  it("lets a request through that does not name its version: every installed build, which sends no header", async () => {
    const { res, reachedRoute } = await get("/api/mobile/events")
    expect(reachedRoute).toBe(true)
    expect(res.status).toBe(401)
  })

  it("lets a current build through to the route", async () => {
    const { res, reachedRoute } = await get("/api/mobile/events", { "x-app-version": "1.0.1" })
    expect(reachedRoute).toBe(true)
    expect(res.status).toBe(401)
  })

  it("does not ask the healthcheck which version it is", async () => {
    const { res, reachedRoute } = await get("/api/health", { "x-app-version": "0.0.1" })
    expect(reachedRoute).toBe(true)
    expect(res.status).toBe(200)
  })
})

describe("the minimum build number (MOBILE_MIN_APP_BUILD_*, SCRUM-851)", () => {
  beforeEach(() => {
    process.env.MOBILE_MIN_APP_BUILD_IOS = "127"
    process.env.MOBILE_MIN_APP_BUILD_ANDROID = "40"
  })

  it("answers an iOS build below its minimum 426 UPDATE_REQUIRED, and never reaches the route", async () => {
    const { res, reachedRoute } = await get("/api/mobile/events", { "x-app-version": "1.0.0", "x-app-build": "126", "x-app-platform": "ios" })
    expect(reachedRoute).toBe(false)
    expect(res.status).toBe(426)
    expect(await res.json()).toMatchObject({ success: false, errorCode: "UPDATE_REQUIRED" })
  })

  it("judges each platform by its own minimum", async () => {
    const android126 = await get("/api/mobile/events", { "x-app-build": "126", "x-app-platform": "android" })
    expect(android126.reachedRoute).toBe(true)
    const android39 = await get("/api/mobile/events", { "x-app-build": "39", "x-app-platform": "android" })
    expect(android39.res.status).toBe(426)
    const ios127 = await get("/api/mobile/events", { "x-app-build": "127", "x-app-platform": "ios" })
    expect(ios127.reachedRoute).toBe(true)
  })

  it("passes with no build header (every installed build), a bad one, or an unknown platform", async () => {
    for (const headers of [{} as Record<string, string>, { "x-app-platform": "ios" }, { "x-app-build": "abc", "x-app-platform": "ios" }, { "x-app-build": "1" }, { "x-app-build": "1", "x-app-platform": "web" }]) {
      const { res, reachedRoute } = await get("/api/mobile/events", headers)
      expect(reachedRoute).toBe(true)
      expect(res.status).toBe(401)
    }
  })

  it("is off with no minimum set", async () => {
    delete process.env.MOBILE_MIN_APP_BUILD_IOS
    expect((await get("/api/mobile/events", { "x-app-build": "1", "x-app-platform": "ios" })).reachedRoute).toBe(true)
  })
})
