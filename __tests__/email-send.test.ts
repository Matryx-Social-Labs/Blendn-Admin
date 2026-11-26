const mockWarn = jest.fn()
const mockFindSuppression = jest.fn()
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), debug: jest.fn() },
}))
jest.mock("@/lib/db", () => ({
  db: { email_suppressions: { findUnique: (...a: unknown[]) => mockFindSuppression(...a) } },
}))

import { sendEmail } from "@/lib/email"

/*
 * SCRUM-1280 (launch gate 14): one retry on a transient failure, Reply-To,
 * headers, and no mail to an address that bounced or complained.
 *
 * `fetch` is the Resend client (lib/email.ts has no SDK), so "sent" means
 * "fetch was called". The retry's one-second wait is made instant.
 */
const ENV = { ...process.env }
let fetchMock: jest.Mock

const ok = () => ({ ok: true, status: 200, json: async () => ({ id: "em_1" }), text: async () => "" })
const status = (s: number) => ({ ok: false, status: s, json: async () => ({}), text: async () => "nope" })
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body)
const headersOf = (call: number) => fetchMock.mock.calls[call][1].headers as Record<string, string>

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...ENV,
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Blend'n <hello@blendn.app>",
    RAILWAY_ENVIRONMENT_NAME: "production",
  }
  delete process.env.EMAIL_REPLY_TO
  mockFindSuppression.mockResolvedValue(null)
  fetchMock = jest.fn().mockResolvedValue(ok())
  global.fetch = fetchMock as unknown as typeof fetch
  jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
    fn()
    return 0
  }) as unknown as typeof setTimeout)
})

afterEach(() => jest.restoreAllMocks())
afterAll(() => {
  process.env = ENV
})

const send = (extra: Partial<Parameters<typeof sendEmail>[0]> = {}) =>
  sendEmail({ to: "a@blendn.app", subject: "s", text: "t", ...extra })

describe("one retry on a transient failure", () => {
  it("retries a 503 once, and the second attempt's success is the answer", async () => {
    fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok())
    const r = await send()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ sent: true, id: "em_1" })
  })

  it("retries a 429 once", async () => {
    fetchMock.mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok())
    expect((await send()).sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("retries a network throw once", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok())
    expect((await send()).sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("gives up after the second failure: two attempts, never three", async () => {
    fetchMock.mockResolvedValue(status(500))
    expect(await send()).toMatchObject({ sent: false, reason: "provider_error" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry a 400: the same request is refused the same way", async () => {
    fetchMock.mockResolvedValue(status(400))
    expect(await send()).toMatchObject({ sent: false, reason: "provider_error" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends both attempts under one Idempotency-Key, so a retry after a lost answer is not a second mail", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok())
    await send()
    const first = headersOf(0)["Idempotency-Key"]
    expect(first).toMatch(/\S{16,}/)
    expect(headersOf(1)["Idempotency-Key"]).toBe(first)
    await send()
    expect(headersOf(2)["Idempotency-Key"]).not.toBe(first)
  })

  it("waits about a second, with jitter, before the retry", async () => {
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(ok())
    await send()
    const waits = (setTimeout as unknown as jest.Mock).mock.calls.map((c) => c[1] as number)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThanOrEqual(1000)
    expect(waits[0]).toBeLessThan(1500)
  })
})

describe("Reply-To and headers", () => {
  it("sends reply_to when EMAIL_REPLY_TO is set", async () => {
    process.env.EMAIL_REPLY_TO = "support@blendn.app"
    await send()
    expect(bodyOf(0).reply_to).toBe("support@blendn.app")
  })

  it("sends no reply_to when EMAIL_REPLY_TO is unset", async () => {
    await send()
    expect(bodyOf(0)).not.toHaveProperty("reply_to")
  })

  it("passes headers through, each value on one line", async () => {
    await send({ headers: { "List-Unsubscribe": "<https://x/u?t=1>\r\nBcc: evil@x.io" } })
    expect(bodyOf(0).headers).toEqual({ "List-Unsubscribe": "<https://x/u?t=1> Bcc: evil@x.io" })
  })

  it("passes tags through", async () => {
    await send({ tags: [{ name: "kind", value: "results" }] })
    expect(bodyOf(0).tags).toEqual([{ name: "kind", value: "results" }])
  })

  it("sends no headers or tags when none are given", async () => {
    await send()
    expect(bodyOf(0)).not.toHaveProperty("headers")
    expect(bodyOf(0)).not.toHaveProperty("tags")
  })
})

describe("suppressed addresses", () => {
  const suppressed = (reason: string) => mockFindSuppression.mockResolvedValue({ reason })

  it("looks the address up the way sign-in stores it: trimmed and lower-cased", async () => {
    await send({ to: "  A@Blendn.App " })
    expect(mockFindSuppression).toHaveBeenCalledWith(expect.objectContaining({ where: { email: "a@blendn.app" } }))
  })

  it("does not send to a suppressed address, and says why", async () => {
    suppressed("bounce")
    expect(await send()).toEqual({ sent: false, reason: "suppressed" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /* Each row of the scope table (lane advisor call, SCRUM-1280 skill pass). */
  it.each`
    reason           | stream              | sent
    ${"bounce"}      | ${undefined}        | ${false}
    ${"bounce"}      | ${"password_reset"} | ${false}
    ${"bounce"}      | ${"lifecycle"}      | ${false}
    ${"complaint"}   | ${undefined}        | ${false}
    ${"complaint"}   | ${"password_reset"} | ${true}
    ${"complaint"}   | ${"lifecycle"}      | ${false}
    ${"unsubscribe"} | ${undefined}        | ${true}
    ${"unsubscribe"} | ${"password_reset"} | ${true}
    ${"unsubscribe"} | ${"lifecycle"}      | ${false}
  `("a $reason row and a $stream send: sent = $sent", async ({ reason, stream, sent }) => {
    suppressed(reason)
    const r = await send(stream ? { stream } : {})
    expect(r.sent).toBe(sent)
    expect(fetchMock).toHaveBeenCalledTimes(sent ? 1 : 0)
  })

  it("sends anyway when the lookup throws, and warns without the address", async () => {
    mockFindSuppression.mockRejectedValue(new Error("connection refused"))
    const r = await send({ to: "priya.rao@blendn.app" })
    expect(r.sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockWarn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("priya.rao")
  })
})
