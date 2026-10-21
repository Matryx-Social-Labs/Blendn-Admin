import { NextRequest } from "next/server"

import { mobileGateRefusal, parseAppVersion } from "@/lib/mobile-gate"
import { middleware } from "@/middleware"

/*
 * The two refusals every mobile request passes (Flow 15): a build the server no
 * longer serves, and planned downtime. Both are off until a variable is set,
 * and both fail open — the rules below are mostly about what is NOT refused.
 *
 * The first block is the rule; the second drives the real middleware, which is
 * where "the healthcheck and the dashboard are exempt" is decided.
 */

describe("parseAppVersion", () => {
  it.each([
    ["1.4.0", [1, 4, 0, 0]],
    ["2", [2, 0, 0, 0]],
    [" 1.0.10 ", [1, 0, 10, 0]],
    ["1.2.3.4", [1, 2, 3, 4]],
  ])("reads %s", (raw, expected) => expect(parseAppVersion(raw)).toEqual(expected))

  it.each(["unknown", "", "   ", "1.0.0-beta", "v1.0", "1..0", "1.2.3.4.5", "99999999999999999999.0"])(
    "does not read %p",
    (raw) => expect(parseAppVersion(raw)).toBeNull()
  )

  it("does not read a missing header", () => {
    expect(parseAppVersion(null)).toBeNull()
    expect(parseAppVersion(undefined)).toBeNull()
  })
})

describe("the minimum app version", () => {
  const env = { MOBILE_MIN_APP_VERSION: "1.4.0" }

  it("refuses a plain version below the minimum with 426 UPDATE_REQUIRED", () => {
    const refusal = mobileGateRefusal("1.3.9", env)
    expect(refusal?.status).toBe(426)
    expect(refusal?.body).toMatchObject({ success: false, errorCode: "UPDATE_REQUIRED" })
  })

  it.each(["1.4.0", "1.4", "1.10.0", "2.0.0"])("lets %s through (at or above)", (version) => {
    expect(mobileGateRefusal(version, env)).toBeNull()
  })

  it("compares numbers, not strings (1.10 is newer than 1.9)", () => {
    expect(mobileGateRefusal("1.10.0", { MOBILE_MIN_APP_VERSION: "1.9.0" })).toBeNull()
    expect(mobileGateRefusal("1.9.0", { MOBILE_MIN_APP_VERSION: "1.10.0" })?.status).toBe(426)
  })

  it.each([null, "unknown", "", "garbage", "1.0.0-beta"])("never refuses a header that is %p", (header) => {
    expect(mobileGateRefusal(header, env)).toBeNull()
  })

  it.each([undefined, "", "   "])("is off when the minimum is %p", (min) => {
    expect(mobileGateRefusal("0.0.1", { MOBILE_MIN_APP_VERSION: min })).toBeNull()
  })

  it("is off, and says so once, when the minimum is not a version", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(mobileGateRefusal("0.0.1", { MOBILE_MIN_APP_VERSION: "soon" })).toBeNull()
      expect(mobileGateRefusal("0.0.1", { MOBILE_MIN_APP_VERSION: "soon" })).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("maintenance", () => {
  it.each(["1", "true", "TRUE", " 1 "])("is on for MAINTENANCE_MODE=%p, 503 with the wait in body and header", (mode) => {
    const refusal = mobileGateRefusal("1.0.0", { MAINTENANCE_MODE: mode })
    expect(refusal?.status).toBe(503)
    expect(refusal?.body).toMatchObject({ success: false, errorCode: "MAINTENANCE", retryAfter: 300 })
    expect(refusal?.headers["Retry-After"]).toBe("300")
  })

  it.each([undefined, "", "0", "false", "no"])("is off for MAINTENANCE_MODE=%p", (mode) => {
    expect(mobileGateRefusal("1.0.0", { MAINTENANCE_MODE: mode })).toBeNull()
  })

  it.each([
    ["120", 120],
    ["999999", 3600],
    ["0", 300],
    ["-5", 300],
    ["soon", 300],
    ["1.5", 300],
  ])("takes MAINTENANCE_RETRY_AFTER_SECONDS=%p as %p", (configured, seconds) => {
    const refusal = mobileGateRefusal(null, { MAINTENANCE_MODE: "1", MAINTENANCE_RETRY_AFTER_SECONDS: configured })
    expect(refusal?.body.retryAfter).toBe(seconds)
    expect(refusal?.headers["Retry-After"]).toBe(String(seconds))
  })

  it("is said before an update is asked for", () => {
    const refusal = mobileGateRefusal("1.0.0", { MAINTENANCE_MODE: "1", MOBILE_MIN_APP_VERSION: "9.0.0" })
    expect(refusal?.body.errorCode).toBe("MAINTENANCE")
  })
})

describe("the middleware", () => {
  const VARIABLES = ["MOBILE_MIN_APP_VERSION", "MAINTENANCE_MODE", "MAINTENANCE_RETRY_AFTER_SECONDS"] as const
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]))
  afterEach(() => {
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    middleware(new NextRequest(`http://localhost${path}`, { method, headers }))
  const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1"

  describe("with a minimum of 1.4.0", () => {
    beforeEach(() => {
      process.env.MOBILE_MIN_APP_VERSION = "1.4.0"
    })

    it("answers an old build 426 UPDATE_REQUIRED, on a versioned path too, with the CORS headers", async () => {
      for (const path of ["/api/mobile/events", "/api/mobile/v1/events"]) {
        const res = await call(path, { "x-app-version": "1.3.0" })
        expect(res.status).toBe(426)
        expect(await res.json()).toMatchObject({ success: false, errorCode: "UPDATE_REQUIRED" })
        expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-App-Version")
      }
    })

    it("passes a build that is current", async () => {
      expect(passedThrough(await call("/api/mobile/events", { "x-app-version": "1.4.0" }))).toBe(true)
    })

    it.each<[Record<string, string>]>([[{}], [{ "x-app-version": "unknown" }], [{ "x-app-version": "garbage" }], [{ "x-app-version": "" }]])(
      "passes a request that does not name a version it can be judged by (%j)",
      async (headers) => {
        expect(passedThrough(await call("/api/mobile/events", headers))).toBe(true)
      }
    )

    it("does not ask a preflight, which cannot carry the header", async () => {
      const res = await call("/api/mobile/events", {}, "OPTIONS")
      expect(res.status).toBe(200)
    })

    it("never asks the healthcheck or the dashboard", async () => {
      expect(passedThrough(await call("/api/health", { "x-app-version": "0.0.1" }))).toBe(true)
      expect((await call("/dashboard", { "x-app-version": "0.0.1" })).status).not.toBe(426)
    })
  })

  describe("in maintenance", () => {
    beforeEach(() => {
      process.env.MAINTENANCE_MODE = "1"
      process.env.MAINTENANCE_RETRY_AFTER_SECONDS = "90"
    })

    it("answers every mobile request 503 MAINTENANCE with Retry-After, whatever the version, on a versioned path too", async () => {
      for (const path of ["/api/mobile/events", "/api/mobile/v1/auth/session", "/api/mobile/auth/signin"]) {
        for (const headers of [{}, { "x-app-version": "9.9.9" }] as Record<string, string>[]) {
          const res = await call(path, headers, path.endsWith("signin") ? "POST" : "GET")
          expect(res.status).toBe(503)
          expect(res.headers.get("Retry-After")).toBe("90")
          expect(await res.json()).toMatchObject({ success: false, errorCode: "MAINTENANCE", retryAfter: 90 })
        }
      }
    })

    it("exempts /api/health, which Railway's healthcheck would otherwise fail the deploy on", async () => {
      const res = await call("/api/health")
      expect(res.status).toBe(200)
      expect(passedThrough(res)).toBe(true)
    })

    it("exempts the dashboard and the sign-in page", async () => {
      const dashboard = await call("/dashboard")
      expect(dashboard.status).toBe(307)
      expect(dashboard.headers.get("location")).toContain("/login")
      expect(passedThrough(await call("/login"))).toBe(true)
    })

    it("answers a preflight normally, so a browser can read the 503", async () => {
      expect((await call("/api/mobile/events", {}, "OPTIONS")).status).toBe(200)
    })
  })

  it("is off with nothing set", async () => {
    for (const name of VARIABLES) delete process.env[name]
    expect(passedThrough(await call("/api/mobile/events", { "x-app-version": "0.0.1" }))).toBe(true)
  })

  it("allows X-App-Version in CORS preflight", async () => {
    const res = await call("/api/mobile/events", { origin: "https://blendn.app" }, "OPTIONS")
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization, X-App-Version")
  })
})
