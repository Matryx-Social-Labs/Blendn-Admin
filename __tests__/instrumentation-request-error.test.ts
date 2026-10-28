/*
 * Next hands an error it caught itself (a route handler that threw, a server
 * component, a server action) to `onRequestError` and to nothing else. It was an
 * empty function, so those errors never reached Sentry (SCRUM-649).
 */
const captureRequestError = jest.fn()
jest.mock("@sentry/nextjs", () => ({ captureRequestError: (...args: unknown[]) => captureRequestError(...args) }))

import { NextRequest } from "next/server"

import { onRequestError } from "@/instrumentation"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const probe = require("@/app/api/health/sentry-probe/route") as typeof import("@/app/api/health/sentry-probe/route")

beforeEach(() => {
  captureRequestError.mockClear()
  delete process.env.SENTRY_PROBE_TOKEN
})

describe("onRequestError", () => {
  it("passes what Next caught to Sentry", () => {
    const err = new Error("boom")
    const request = { path: "/api/x", method: "GET", headers: {} }
    const context = { routerKind: "App Router", routePath: "/api/x", routeType: "route", renderSource: undefined }
    ;(onRequestError as unknown as (...a: unknown[]) => void)(err, request, context)
    expect(captureRequestError).toHaveBeenCalledWith(err, request, context)
  })
})

describe("the probe route", () => {
  const call = (headers: Record<string, string> = {}) => probe.GET(new NextRequest("http://localhost/api/health/sentry-probe?run=t1", { headers }))

  it("is a 404 when the flag is not set, whatever header is sent", async () => {
    expect((await call()).status).toBe(404)
    expect((await call({ "x-probe-token": "" })).status).toBe(404)
    expect((await call({ "x-probe-token": "anything" })).status).toBe(404)
  })

  it("is a 404 with the flag set but the wrong or no token", async () => {
    process.env.SENTRY_PROBE_TOKEN = "right-token-0123456789"
    expect((await call()).status).toBe(404)
    expect((await call({ "x-probe-token": "wrong-token-012345678" })).status).toBe(404)
    expect((await call({ "x-probe-token": "short" })).status).toBe(404)
  })

  it("throws, as an unhandled 500 does, with the right token", async () => {
    process.env.SENTRY_PROBE_TOKEN = "right-token-0123456789"
    await expect(call({ "x-probe-token": "right-token-0123456789" })).rejects.toThrow(/sentry-probe: deliberate/)
  })
})
