import { NextRequest } from "next/server"

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"

import { mobileGateRefusal, parseAppVersion } from "@/lib/mobile-gate"
import { config, middleware } from "@/middleware"

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

describe("the minimum build number (SCRUM-851)", () => {
  const env = { MOBILE_MIN_APP_BUILD_IOS: "127", MOBILE_MIN_APP_BUILD_ANDROID: "40" }
  const ios = (build: string | null) => ({ build, platform: "ios", userAgent: null })
  const android = (build: string | null) => ({ build, platform: "android", userAgent: null })

  it("refuses a build below its platform's minimum with the same 426 UPDATE_REQUIRED", () => {
    expect(mobileGateRefusal("1.0.0", env, ios("126"))?.body).toMatchObject({ errorCode: "UPDATE_REQUIRED" })
    expect(mobileGateRefusal("1.0.0", env, android("39"))?.status).toBe(426)
  })

  it("lets a build at or above through, and judges each platform by its own minimum", () => {
    expect(mobileGateRefusal("1.0.0", env, ios("127"))).toBeNull()
    expect(mobileGateRefusal("1.0.0", env, ios("1000"))).toBeNull()
    expect(mobileGateRefusal("1.0.0", env, android("126"))).toBeNull()
    expect(mobileGateRefusal("1.0.0", env, android("39"))?.status).toBe(426)
  })

  it("reads the platform from the user agent when it is not named", () => {
    expect(mobileGateRefusal(null, env, { build: "5", platform: null, userAgent: "okhttp/4.12.0" })?.status).toBe(426)
    expect(mobileGateRefusal(null, env, { build: "5", platform: null, userAgent: "Blendn/126 CFNetwork/1568 Darwin/24" })?.status).toBe(426)
  })

  it.each([null, "", "abc", "12.5", "-3"])("never refuses a build header that is %p", (build) => {
    expect(mobileGateRefusal("1.0.0", env, ios(build))).toBeNull()
  })

  it("never refuses with no header at all, an unknown platform, or no minimum set", () => {
    expect(mobileGateRefusal("1.0.0", env)).toBeNull()
    expect(mobileGateRefusal(null, env, { build: "1", platform: null, userAgent: "curl/8" })).toBeNull()
    expect(mobileGateRefusal(null, {}, ios("1"))).toBeNull()
    expect(mobileGateRefusal(null, { MOBILE_MIN_APP_BUILD_IOS: "  " }, ios("1"))).toBeNull()
  })

  it("is off, and says so once, when the minimum is not a build number", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(mobileGateRefusal(null, { MOBILE_MIN_APP_BUILD_IOS: "soon" }, ios("1"))).toBeNull()
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

  it("is off, and says so once, for a value that is neither on nor a known off (a typo for downtime)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      for (const mode of ["yes", "yes", "on"]) expect(mobileGateRefusal(null, { MAINTENANCE_MODE: mode })).toBeNull()
      for (const mode of ["0", "false", "no", "off", ""]) expect(mobileGateRefusal(null, { MAINTENANCE_MODE: mode })).toBeNull()
      // "yes" once, "on" once; the known offs and the empty string say nothing.
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
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

    it("does not judge a preflight, even one that names an old version", async () => {
      for (const path of ["/api/mobile/events", "/api/mobile/v1/events"]) {
        const res = await call(path, { "x-app-version": "0.0.1" }, "OPTIONS")
        expect(res.status).toBe(200)
      }
    })

    it("never asks the healthcheck or the dashboard", async () => {
      expect(passedThrough(await call("/api/health", { "x-app-version": "0.0.1" }))).toBe(true)
      const dashboard = await call("/dashboard", { "x-app-version": "0.0.1" })
      expect(dashboard.status).toBe(307)
      expect(new URL(dashboard.headers.get("location")!).pathname).toBe("/login")
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

    it("exempts the dashboard, the root, the sign-in page and the internal API docs", async () => {
      const toLogin = async (path: string) => {
        const res = await call(path)
        expect(res.status).toBe(307)
        expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
      }
      await toLogin("/dashboard")
      await toLogin("/")
      await toLogin("/api-docs")
      expect(passedThrough(await call("/login"))).toBe(true)
      // Not 503: the docs answer an anonymous caller 404, as they do with maintenance off.
      expect((await call("/api/docs")).status).toBe(404)
    })

    it("answers a preflight normally, so a browser can read the 503", async () => {
      for (const path of ["/api/mobile/events", "/api/mobile/v1/x"]) {
        expect((await call(path, {}, "OPTIONS")).status).toBe(200)
      }
    })
  })

  it("fails open at the middleware for a minimum that is not a version and a mode that is not on", async () => {
    process.env.MOBILE_MIN_APP_VERSION = "soon"
    process.env.MAINTENANCE_MODE = "garbage"
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(passedThrough(await call("/api/mobile/events", { "x-app-version": "0.0.1" }))).toBe(true)
      // A versioned path is rewritten, not passed on.
      const versioned = await call("/api/mobile/v1/events", { "x-app-version": "0.0.1" })
      expect(versioned.status).toBe(200)
      expect(versioned.headers.get("x-middleware-rewrite")).toContain("/api/mobile/events")
    } finally {
      warn.mockRestore()
    }
  })

  describe("which paths run the middleware at all (config.matcher)", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url: `http://localhost${url}` })

    it.each(["/api/mobile/events", "/api/mobile/v1/auth/session", "/dashboard", "/dashboard/events", "/", "/login", "/api-docs", "/api/docs"])(
      "runs for %s",
      (path) => expect(matches(path)).toBe(true)
    )

    it.each(["/api/health", "/api/auth/session", "/api/leads", "/socket.io/"])(
      "does not run for %s, so no gate can touch the healthcheck, NextAuth or the socket",
      (path) => expect(matches(path)).toBe(false)
    )
  })

  it("is off with nothing set", async () => {
    for (const name of VARIABLES) delete process.env[name]
    expect(passedThrough(await call("/api/mobile/events", { "x-app-version": "0.0.1" }))).toBe(true)
  })

  it("allows X-App-Version in CORS preflight", async () => {
    const res = await call("/api/mobile/events", { origin: "https://blendn.app" }, "OPTIONS")
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization, X-App-Version, X-App-Build, X-App-Platform, X-Channel-Set, X-Client-Features, X-Country")
  })
})
