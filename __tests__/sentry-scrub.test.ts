import type { ErrorEvent, EventHint } from "@sentry/nextjs"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeSend, scrubString, IGNORED_ERRORS, SENTRY_DATA_COLLECTION } from "@/lib/sentry-scrub"

const send = (event: Partial<ErrorEvent>) =>
  beforeSend(event as ErrorEvent, {} as EventHint)!

describe("scrubString", () => {
  it("removes email addresses", () => {
    expect(scrubString("failed for zaphod@example.com")).not.toContain("zaphod@example.com")
  })

  it("removes JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJhYmMifQ.c2lnbmF0dXJl"
    expect(scrubString(`bad token ${jwt}`)).not.toContain(jwt)
  })

  it("removes presigned URL signatures but keeps the path", () => {
    const url =
      "https://fly.storage.tigris.dev/blendn-media/u/1.jpg?X-Amz-Signature=deadbeefcafe&x=1"
    const out = scrubString(url)
    expect(out).not.toContain("deadbeefcafe")
    expect(out).toContain("blendn-media/u/1.jpg")
  })

  it("leaves ordinary text alone", () => {
    expect(scrubString("Event not found")).toBe("Event not found")
  })
})

describe("beforeSend", () => {
  it("keeps the user id but drops everything else about them", () => {
    const event = send({
      user: { id: "user_abc", email: "zaphod@example.com", username: "zaphod" },
    })
    expect(event.user).toEqual({ id: "user_abc" })
  })

  it("drops cookies and the request body", () => {
    const event = send({
      request: {
        url: "https://api.blendn.app/api/mobile/auth/signin",
        cookies: { session: "secret-value" },
        data: { email: "zaphod@example.com", password: "hunter2" },
      },
    })
    expect(event.request!.cookies).toBeUndefined()
    expect(event.request!.data).toBeUndefined()
  })

  it("redacts the Authorization header", () => {
    const event = send({
      request: {
        url: "https://api.blendn.app/x",
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "user-agent": "blendn/1.0" },
      },
    })
    expect(event.request!.headers!.authorization).toBe("[redacted]")
    // Non-sensitive headers survive — they're what makes an error debuggable.
    expect(event.request!.headers!["user-agent"]).toBe("blendn/1.0")
  })

  it("scrubs the exception message", () => {
    const event = send({
      exception: {
        values: [{ type: "Error", value: "no user for zaphod@example.com" }],
      },
    })
    expect(event.exception!.values![0].value).not.toContain("zaphod@example.com")
  })

  it("redacts sensitive keys in extra context but keeps the rest", () => {
    const event = send({
      extra: { refreshToken: "eyJhbGciOi.abc.def", eventId: "evt_1", attempt: 2 },
    })
    expect(event.extra!.refreshToken).toBe("[redacted]")
    expect(event.extra!.eventId).toBe("evt_1")
    expect(event.extra!.attempt).toBe(2)
  })

  it("scrubs the request URL", () => {
    const event = send({
      request: { url: "https://api.blendn.app/u?X-Amz-Signature=deadbeef" },
    })
    expect(event.request!.url).not.toContain("deadbeef")
  })

  it("survives a sparse event without throwing", () => {
    expect(() => send({})).not.toThrow()
  })
})

describe("IGNORED_ERRORS", () => {
  it("covers navigation aborts, offline errors, and expected auth failures", () => {
    for (const needle of ["AbortError", "NEXT_REDIRECT", "Failed to fetch", "jwt expired"]) {
      expect(IGNORED_ERRORS).toContain(needle)
    }
  })
})

/*
 * Sentry 11 replaced `sendDefaultPii` with `dataCollection`, and left unset it
 * now collects cookies, whole request/response bodies, user IPs and database
 * query data — on transactions and spans, which `beforeSend` never sees. The
 * v10 behaviour this project relied on has to be stated, in every runtime.
 */
describe("SENTRY_DATA_COLLECTION", () => {
  it("keeps the restrictive v10 baseline: no user info, cookies, bodies or query data", () => {
    expect(SENTRY_DATA_COLLECTION.userInfo).toBe(false)
    expect(SENTRY_DATA_COLLECTION.cookies).toBe(false)
    expect(SENTRY_DATA_COLLECTION.httpBodies).toEqual([])
    expect(SENTRY_DATA_COLLECTION.databaseQueryData).toBe(false)
    expect(SENTRY_DATA_COLLECTION.queues).toBe(false)
    expect(SENTRY_DATA_COLLECTION.genAI).toEqual({ inputs: false, outputs: false })
    expect(SENTRY_DATA_COLLECTION.graphQL).toEqual({ document: false, variables: false })
  })

  it("keeps a link's one-time token out of captured URLs", () => {
    expect(SENTRY_DATA_COLLECTION.urlQueryParams.deny).toContain("token")
  })

  it.each(["instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"])(
    "is what %s passes to Sentry.init",
    (file) => {
      const source = readFileSync(join(process.cwd(), file), "utf8")
      expect(source).toMatch(/dataCollection:\s*SENTRY_DATA_COLLECTION/)
      expect(source).not.toMatch(/sendDefaultPii/)
    }
  )
})
