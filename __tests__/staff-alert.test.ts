/**
 * Staff hear about reports and severe flags (SCRUM-1161, launch gate 9).
 *
 * Ten writers create report rows and none of them tells anybody; one sweeper
 * counts what is new since its last run and posts ONE message. These tests are
 * about that message being sent exactly once per batch of rows: not for
 * nothing, not twice, not lost when the channel fails, and never carrying more
 * than counts and a link, because it leaves the platform.
 */

type Row = { id: string; created_at: Date }

const reports: Row[] = []
const mockDb = {
  user_reports: { count: jest.fn() },
  message_reports: { count: jest.fn() },
  event_reports: { count: jest.fn() },
  chat_messages: { count: jest.fn() },
  $queryRaw: jest.fn(),
}
const mockReadMark = jest.fn()
const mockWriteMark = jest.fn()
const mockSendEmail = jest.fn()
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/logger", () => ({ logger: mockLogger }))
jest.mock("@/lib/rate-limit-store", () => ({
  readMark: (...a: unknown[]) => mockReadMark(...a),
  writeMark: (...a: unknown[]) => mockWriteMark(...a),
}))
jest.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
  emailConfigured: () => true,
  dashboardUrl: () => "https://dashboard.blendn.app",
}))

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret-part"
const ENV = { ...process.env }
const BOOT = new Date("2026-11-26T10:00:00Z")
const at = (seconds: number) => new Date(BOOT.getTime() + seconds * 1000)

let fetchMock: jest.Mock
let sweep: (now?: Date) => Promise<void>
let notifyStaff: (text: string) => Promise<string>
let DEGRADED: number
let startLoop: () => void
let stopLoop: () => void

/** A count over `reports` that honours the window the sweep asks for. */
function windowCount({ where }: { where: { status: string; created_at: { gt: Date; lte: Date } } }) {
  const { gt, lte } = where.created_at
  return Promise.resolve(reports.filter((r) => r.created_at > gt && r.created_at <= lte).length)
}

const sql = (strings: TemplateStringsArray) => strings.join("?")
let severe = 0

beforeEach(async () => {
  jest.clearAllMocks()
  jest.resetModules()
  reports.length = 0
  severe = 0
  process.env = { ...ENV }
  process.env.STAFF_ALERT_SLACK_WEBHOOK_URL = WEBHOOK
  delete process.env.STAFF_ALERT_EMAIL
  mockDb.user_reports.count.mockImplementation(windowCount)
  mockDb.message_reports.count.mockResolvedValue(0)
  mockDb.event_reports.count.mockResolvedValue(0)
  mockDb.chat_messages.count.mockResolvedValue(0)
  mockDb.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(
      sql(strings).includes("LEAST")
        ? [{ oldest: reports[0]?.created_at ?? null }]
        : [{ n: severe }]
    )
  )
  mockReadMark.mockResolvedValue(null)
  mockWriteMark.mockResolvedValue(undefined)
  mockSendEmail.mockResolvedValue({ sent: true })
  fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "ok" })
  global.fetch = fetchMock as unknown as typeof fetch
  // Fresh module per test: the in-memory mark starts at boot, like a new process.
  const mod = await import("@/lib/staff-alert")
  sweep = mod.runStaffAlertSweep
  notifyStaff = mod.notifyStaff
  DEGRADED = mod.DEGRADED_UNCHECKED_PER_HOUR
  startLoop = mod.startStaffAlertSweeper
  stopLoop = mod.stopStaffAlertSweeper
})

afterAll(() => {
  process.env = ENV
})

const posted = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).text as string)

describe("the sweep", () => {
  it("posts one message for new rows, with counts, the oldest age and a link", async () => {
    reports.push({ id: "r1", created_at: at(-40) }, { id: "r2", created_at: at(-30) })
    severe = 1
    await sweep(at(0))
    expect(posted()).toHaveLength(1)
    expect(posted()[0]).toContain("2 new reports")
    expect(posted()[0]).toContain("1 severe flag")
    expect(posted()[0]).toMatch(/oldest pending \d+ min/)
    expect(posted()[0]).toContain("https://dashboard.blendn.app/dashboard/moderation")
  })

  it("adds the three report tables together", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    mockDb.message_reports.count.mockResolvedValue(1)
    mockDb.event_reports.count.mockResolvedValue(1)
    await sweep(at(0))
    expect(posted()[0]).toContain("3 new reports")
  })

  it("posts nothing, and logs nothing, when there is nothing new", async () => {
    await sweep(at(0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it("never posts twice for the same rows", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    await sweep(at(0))
    await sweep(at(60))
    await sweep(at(120))
    expect(posted()).toHaveLength(1)
  })

  it("posts again for a row that lands after the last run", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    await sweep(at(0))
    reports.push({ id: "r2", created_at: at(30) })
    await sweep(at(60))
    expect(posted()).toHaveLength(2)
    expect(posted()[1]).toContain("1 new report")
  })

  it("does not lose a row whose transaction commits after the count: the window trails by a grace", async () => {
    await sweep(at(0))
    // created_at is the insert's clock, 1 s before that run; the commit landed after its count.
    reports.push({ id: "r1", created_at: at(-1) })
    await sweep(at(60))
    expect(posted()).toHaveLength(1)
  })

  it("starts its first window one interval before boot when no mark is stored", async () => {
    reports.push({ id: "r1", created_at: at(-50) })
    await sweep(at(0))
    expect(posted()).toHaveLength(1)
  })

  it("resumes from the mark Redis kept, so a restart does not drop a pending row's alert", async () => {
    // Announced by nobody: the last run ended five minutes before this boot.
    reports.push({ id: "r1", created_at: at(-200) })
    mockReadMark.mockResolvedValue(at(-300).toISOString())
    await sweep(at(0))
    expect(posted()).toHaveLength(1)
    expect(mockWriteMark).toHaveBeenCalledWith(expect.any(String), expect.any(String))
  })

  it("prefers the later mark when Redis kept an older one (a write that failed), never re-announcing", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    await sweep(at(0))
    // Redis still answers the boot-time mark: its write failed with a warning.
    mockReadMark.mockResolvedValue(at(-65).toISOString())
    await sweep(at(60))
    expect(posted()).toHaveLength(1)
  })

  it("says nothing about a person: no ids, no names, no content", async () => {
    reports.push({ id: "report-id-123", created_at: at(-30) })
    await sweep(at(0))
    const body = fetchMock.mock.calls[0][1].body as string
    expect(body).not.toContain("report-id-123")
    // The webhook URL is a secret: it is where the message goes, never what it says.
    expect(body).not.toContain("secret-part")
  })
})

describe("no channel configured", () => {
  beforeEach(() => {
    delete process.env.STAFF_ALERT_SLACK_WEBHOOK_URL
  })

  it("logs one info line, does not throw, and does not repeat it for the same rows", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    await expect(sweep(at(0))).resolves.toBeUndefined()
    await sweep(at(60))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockLogger.info).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it("is an error, not an info line, in production", async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production"
    await notifyStaff("x")
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it("notifyStaff says so rather than throwing", async () => {
    await expect(notifyStaff("x")).resolves.toBe("unconfigured")
  })

  it.each([["production"], ["staging"]])("logs the hint but not the page text (%s)", async (name) => {
    process.env.RAILWAY_ENVIRONMENT_NAME = name
    await notifyStaff("Image pulled: key uploads/K-key-123.jpg user U-user-456")
    const logged = JSON.stringify([mockLogger.error.mock.calls, mockLogger.info.mock.calls])
    expect(logged).toContain("STAFF_ALERT_SLACK_WEBHOOK_URL")
    expect(logged).not.toContain("K-key-123")
    expect(logged).not.toContain("U-user-456")
  })
})

describe("a channel that fails", () => {
  it("is logged as an error, never thrown, and the rows are announced on the next run", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to parse URL from ${WEBHOOK}`))
    await expect(sweep(at(0))).resolves.toBeUndefined()
    expect(mockLogger.error).toHaveBeenCalled()
    await sweep(at(60))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(posted()[1]).toContain("1 new report")
  })

  it("never logs the webhook URL, even when the error carries it", async () => {
    reports.push({ id: "r1", created_at: at(-30) })
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to parse URL from ${WEBHOOK}`))
    await sweep(at(0))
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => `no_service ${WEBHOOK}` })
    await sweep(at(60))
    const logged = JSON.stringify([mockLogger.error.mock.calls, mockLogger.warn.mock.calls, mockLogger.info.mock.calls])
    expect(logged).not.toContain("secret-part")
  })

  it("a database failure is logged and the sweep does not throw", async () => {
    mockDb.user_reports.count.mockRejectedValueOnce(new Error("db down"))
    await expect(sweep(at(0))).resolves.toBeUndefined()
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it("an email that is not sent counts as a failure", async () => {
    delete process.env.STAFF_ALERT_SLACK_WEBHOOK_URL
    process.env.STAFF_ALERT_EMAIL = "safety@blendn.app"
    mockSendEmail.mockResolvedValueOnce({ sent: false, reason: "provider_error" })
    await expect(notifyStaff("x")).resolves.toBe("failed")
  })
})

describe("moderation degraded", () => {
  it("is said once when unchecked room lines pass the threshold, even with no reports", async () => {
    mockDb.chat_messages.count.mockResolvedValue(DEGRADED + 1)
    await sweep(at(0))
    await sweep(at(60))
    expect(posted()).toHaveLength(1)
    expect(posted()[0]).toMatch(/moderation degraded/i)
  })

  it("rides along with a report while it lasts", async () => {
    mockDb.chat_messages.count.mockResolvedValue(DEGRADED + 1)
    await sweep(at(0))
    reports.push({ id: "r1", created_at: at(30) })
    await sweep(at(60))
    expect(posted()[1]).toMatch(/moderation degraded/i)
  })

  it("is said again for a second episode, and repeated when its send failed", async () => {
    mockDb.chat_messages.count.mockResolvedValue(DEGRADED + 1)
    fetchMock.mockRejectedValueOnce(new Error("down"))
    await sweep(at(0))
    await sweep(at(60))
    mockDb.chat_messages.count.mockResolvedValue(0)
    await sweep(at(120))
    mockDb.chat_messages.count.mockResolvedValue(DEGRADED + 1)
    await sweep(at(180))
    expect(posted()).toHaveLength(3)
    expect(posted().slice(1).every((t) => /moderation degraded/i.test(t))).toBe(true)
  })

  it("is not said at the threshold", async () => {
    mockDb.chat_messages.count.mockResolvedValue(DEGRADED)
    await sweep(at(0))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("the loop", () => {
  afterEach(() => {
    stopLoop()
    jest.useRealTimers()
  })

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  it("runs at boot and every minute, once however often it is started, and not after stop", async () => {
    jest.useFakeTimers()
    startLoop()
    startLoop()
    await flush()
    expect(mockDb.user_reports.count).toHaveBeenCalledTimes(1)
    for (let minute = 0; minute < 2; minute++) {
      await jest.advanceTimersByTimeAsync(60_000)
      await flush()
    }
    expect(mockDb.user_reports.count).toHaveBeenCalledTimes(3)
    stopLoop()
    await jest.advanceTimersByTimeAsync(180_000)
    expect(mockDb.user_reports.count).toHaveBeenCalledTimes(3)
  })
})

// A module, not a script: its top-level names must not collide with other test files under tsc.
export {}
