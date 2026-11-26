/**
 * SCRUM-1397: a handled failure that is logged with `logger.error` reaches
 * Sentry, so the alert rules can see it. Before this, the logger wrote to the
 * console only and every handled error (a failed push, a sweep that throws,
 * a mail that did not send) lived in Railway's log window alone.
 */
import type { BaseTransportOptions, ClientOptions } from "@sentry/core"
import type { ErrorEvent } from "@sentry/nextjs"

const captureException = jest.fn()
const captureMessage = jest.fn()
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

import { logger } from "@/lib/logger"
import { beforeSend } from "@/lib/sentry-scrub"

beforeEach(() => {
  captureException.mockReset()
  captureMessage.mockReset()
  jest.spyOn(console, "error").mockImplementation()
  jest.spyOn(console, "warn").mockImplementation()
  jest.spyOn(console, "log").mockImplementation()
})
afterEach(() => jest.restoreAllMocks())

describe("logger.error reports to Sentry", () => {
  it("sends an Error in the context to captureException once, grouped by the log message", () => {
    const err = new Error("connection refused")

    logger.error("Reminder sweep failed", { err, eventId: "e1" })

    expect(captureMessage).not.toHaveBeenCalled()
    expect(captureException).toHaveBeenCalledTimes(1)
    const [sent, context] = captureException.mock.calls[0]
    expect(sent).toBe(err)
    expect(context).toMatchObject({
      level: "error",
      fingerprint: ["Reminder sweep failed"],
      extra: { log: "Reminder sweep failed", eventId: "e1" },
    })
    // The Error is the event's exception; a second copy in the extras is only another place for its text to leak.
    expect(context.extra).not.toHaveProperty("err")
  })

  it("sends a message-only call to captureMessage at level error, with the context as extras", () => {
    logger.error("Failed to send push notification", { error: "socket hang up", userId: "u1" })

    expect(captureException).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith("Failed to send push notification", {
      level: "error",
      fingerprint: ["Failed to send push notification"],
      extra: { error: "socket hang up", userId: "u1" },
      tags: undefined,
    })
  })

  it("passes tags through, so one call site can split its issues (push receipts by code and platform)", () => {
    logger.error("Push receipt errors: InvalidCredentials (android)", { count: 2 }, { push_error: "InvalidCredentials", platform: "android" })

    expect(captureMessage).toHaveBeenCalledWith(
      "Push receipt errors: InvalidCredentials (android)",
      expect.objectContaining({ tags: { push_error: "InvalidCredentials", platform: "android" } })
    )
  })

  it("still writes the console line, once", () => {
    logger.error("Lobby purge failed", { error: "timeout" })
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(String((console.error as jest.Mock).mock.calls[0][0])).toContain("Lobby purge failed")
  })

  it("never throws into the caller when Sentry does, and still writes the console line", () => {
    captureMessage.mockImplementation(() => {
      throw new Error("sentry is down")
    })

    expect(() => logger.error("Mail failed", { error: "550" })).not.toThrow()
    const lines = (console.error as jest.Mock).mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes("Mail failed"))).toBe(true)
    // The failure is said once, on the console, and not by calling logger.error again (which would report again).
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it("redacts what the existing scrub redacts, in what Sentry receives", () => {
    logger.error("Sign-in mail failed", { accessToken: "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", error: "rejected for ravi@example.com" })

    const { extra } = captureMessage.mock.calls[0][1]
    const event = beforeSend({ message: "Sign-in mail failed", extra } as ErrorEvent, {})
    expect(event?.extra).toEqual({ accessToken: "[redacted]", error: "rejected for [redacted]" })
  })
})

describe("below error stays on the console", () => {
  it("logger.warn, info and debug report nothing", () => {
    logger.warn("Could not apply bucket policy", { error: "403" })
    logger.info("Event reminders sent", { sent: 3 })
    logger.debug("tick")

    expect(captureException).not.toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled()
  })
})

/*
 * The custom server (`dist/server.js`, tsc output) requires its own copy of
 * lib/ and of the SDK from node_modules; Sentry is initialised inside Next's
 * bundle by instrumentation.ts. They meet because the SDK keeps its client on
 * `globalThis.__SENTRY__[<version>]`, not in module state, and one version is
 * installed. Two module instances of the SDK in one process stand in for the
 * two copies here: a capture from the second reaches the client bound by the first.
 */
describe("a capture from a second copy of the SDK reaches the client the first copy bound", () => {
  it("delivers the event", async () => {
    type Core = typeof import("@sentry/core")
    let first!: Core
    let second!: Core
    jest.isolateModules(() => (first = jest.requireActual("@sentry/core")))
    jest.isolateModules(() => (second = jest.requireActual("@sentry/core")))
    expect(second).not.toBe(first)

    const seen: ErrorEvent[] = []
    class TestClient extends first.Client<ClientOptions> {
      constructor(options: ClientOptions) {
        super(options)
      }
      eventFromException(e: unknown) {
        return Promise.resolve({ exception: { values: [{ value: String(e) }] } })
      }
      eventFromMessage(message: unknown, level?: string) {
        return Promise.resolve({ message: String(message), level } as ErrorEvent)
      }
    }
    const client = new TestClient({
      dsn: "https://public@o0.ingest.sentry.io/0",
      integrations: [],
      stackParser: () => [],
      transport: (options: BaseTransportOptions) => first.createTransport(options, async () => ({})),
      beforeSend: (event: ErrorEvent) => {
        seen.push(event)
        return null
      },
    })
    first.setCurrentClient(client)
    client.init()

    second.captureMessage("from the custom server's copy", "error")
    await client.flush(1000)

    expect(seen.map((e) => e.message)).toEqual(["from the custom server's copy"])
    first.getCurrentScope().setClient(undefined)
  })
})
