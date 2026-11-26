/*
 * `notifications` was a second, permanent copy of every DM in the product.
 *
 * `recordNotification` stored the push body verbatim, and for three kinds that
 * body is something a person wrote — up to 100 characters of a private message.
 * The row is plain text, sits outside every access control that guards
 * `private_messages`, and nothing ever pruned it. No retention job, no TTL, no
 * cron: rows left only when the user tapped CLEAR or deleted their account.
 *
 * So any privacy claim about DMs was false in a place nobody was looking, and
 * would have stayed false under encryption.
 *
 * Two halves, both tested here: the row stops carrying the words, and the table
 * stops growing forever.
 */

import { readFileSync } from "fs"
import { join } from "path"

const mockDb = { $executeRaw: jest.fn() }

jest.mock("@/lib/db", () => ({ db: mockDb }))
const mockPurgeDeletedAccountRecords = jest.fn()
const mockPurgeLeadPii = jest.fn()
jest.mock("@/lib/deleted-account-records", () => ({ purgeDeletedAccountRecords: mockPurgeDeletedAccountRecords }))
jest.mock("@/lib/leads", () => ({ purgeLeadPii: mockPurgeLeadPii }))

import { storedBodyFor } from "@/lib/push-notifications"
import {
  pruneNotifications,
  pruneProductEvents,
  runSweep,
  READ_RETENTION_DAYS,
  UNREAD_RETENTION_DAYS,
  startNotificationRetentionSweeper,
  stopNotificationRetentionSweeper,
} from "@/lib/notification-retention"
import { logger } from "@/lib/logger"

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$executeRaw.mockResolvedValue(0)
})

/** The SQL text and bound values of the nth `$executeRaw` tagged-template call. */
const rawCall = (n = 0) => {
  const [strings, ...values] = mockDb.$executeRaw.mock.calls[n] as [TemplateStringsArray, ...unknown[]]
  return { sql: strings.join("?").replace(/\s+/g, " "), values }
}
const DAY = 24 * 60 * 60 * 1000

describe("the stored row does not keep what somebody wrote", () => {
  it("redacts a private message", () => {
    expect(storedBodyFor("private_message", "meet me by the bar in 5")).toBe("Sent you a message")
  })

  it("redacts a room message, sender prefix and all", () => {
    expect(storedBodyFor("group_message", "Cosmic Panda: anyone near the door?")).toBe(
      "New message in the room"
    )
  })

  it("redacts an announcement", () => {
    expect(storedBodyFor("announcement", "Last orders in 20 minutes")).toBe(
      "Posted an announcement"
    )
  })

  it("leaves kinds that carry no user content alone", () => {
    /*
     * These bodies are fixed strings written by us. Redacting them would lose
     * real information from the bell and gain nothing — there is nobody's
     * writing in them to protect.
     */
    expect(storedBodyFor("match", "Someone you liked has liked you back.")).toBe(
      "Someone you liked has liked you back."
    )
    expect(storedBodyFor("event_update", "This event has been cancelled")).toBe(
      "This event has been cancelled"
    )
    expect(storedBodyFor("reveal_request", "A match wants to see who you are.")).toBe(
      "A match wants to see who you are."
    )
  })

  it("never returns the original text for a content-bearing kind", () => {
    const secret = "my address is 12 Church St"
    for (const kind of ["private_message", "group_message", "announcement"]) {
      expect(storedBodyFor(kind, secret)).not.toContain("Church")
    }
  })
})

describe("redaction is actually wired into both write paths", () => {
  /*
   * The unit tests above pass whether or not anybody calls `storedBodyFor` —
   * a negative control proved it: deleting both call sites left them green.
   * That is the exact shape R16 exists to catch, so the call sites get their
   * own assertion.
   *
   * Two paths write this table: `recordNotification` for a single send, and a
   * `createMany` for a bulk one. Fixing one and not the other would leave every
   * organiser announcement stored verbatim.
   */
  const SRC = () =>
    readFileSync(join(__dirname, "..", "lib", "push-notifications.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("both the single and the bulk insert redact", () => {
    const calls = SRC().match(/body:\s*storedBodyFor\(/g) ?? []
    expect(calls.length).toBe(2)
  })

  it("neither insert passes the raw body through", () => {
    // `body,` on its own inside a notifications insert is the bug.
    const inserts = SRC().match(/db\.notifications\s*\n?\s*\.?(?:create|createMany|createManyAndReturn)\([\s\S]{0,400}?\}\)/g) ?? []
    expect(inserts.length).toBeGreaterThan(0)
    for (const insert of inserts) {
      expect(insert).not.toMatch(/^\s*body,\s*$/m)
    }
  })
})

describe("the table stops growing forever", () => {
  it("keeps unread rows longer than read ones", () => {
    /*
     * An unread row is still doing its job — it is the thing in the bell
     * nobody has looked at yet, and deleting it loses information the user
     * never received. A read row is history.
     */
    expect(UNREAD_RETENTION_DAYS).toBeGreaterThan(READ_RETENTION_DAYS)
  })

  it("prunes read rows past the read window and unread rows past the unread one", async () => {
    const now = new Date("2026-08-20T12:00:00Z")
    await pruneNotifications(now)

    const { sql, values } = rawCall()
    expect(sql).toContain("WHERE read_at < ? OR (read_at IS NULL AND created_at < ?)")
    expect(values[0]).toEqual(new Date(now.getTime() - READ_RETENTION_DAYS * DAY))
    expect(values[1]).toEqual(new Date(now.getTime() - UNREAD_RETENTION_DAYS * DAY))
  })

  it("is bounded per batch", async () => {
    /*
     * A first run against a table that has never been pruned would otherwise be
     * one unbounded delete over years of rows, taking locks on a table every
     * bell read touches.
     */
    await pruneNotifications(new Date())
    const { sql, values } = rawCall()
    expect(sql).toMatch(/LIMIT \?/)
    expect(values.at(-1)).toBe(5_000)
  })

  it("deletes a batch by primary key, never IN (subquery)", async () => {
    // With IN the planner hash-joins every batch against a scan of the whole table (EXPLAIN, SCRUM-1224).
    await pruneNotifications(new Date())
    await pruneProductEvents(new Date())
    for (const n of [0, 1]) {
      expect(rawCall(n).sql).toMatch(/WHERE id = ANY\(ARRAY\( SELECT id FROM/)
      expect(rawCall(n).sql).not.toMatch(/\bIN \(/)
    }
  })
})

describe("one sweep drains the backlog, within a bound (SCRUM-1224)", () => {
  const BATCH = 5_000
  let info: jest.SpyInstance
  let error: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    info = jest.spyOn(logger, "info").mockImplementation(() => {})
    error = jest.spyOn(logger, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    jest.useRealTimers()
    info.mockRestore()
    error.mockRestore()
  })

  /** Notification batches return what `batch` says; product events find nothing. */
  function notificationBatches(batch: (n: number) => number) {
    let n = 0
    mockDb.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("FROM notifications") ? batch(n++) : 0
    )
  }
  const productEventBatches = () =>
    mockDb.$executeRaw.mock.calls.filter(([strings]) => (strings as TemplateStringsArray).join("").includes("FROM product_events")).length

  async function sweep() {
    const done = runSweep()
    await jest.runAllTimersAsync()
    await done
  }

  it("repeats while a batch comes back full, and stops at the first short one", async () => {
    notificationBatches((n) => [BATCH, BATCH, 2_000][n] ?? 0)
    await sweep()
    expect(info).toHaveBeenCalledWith("Pruned notifications", { deleted: 12_000, batches: 3 })
    expect(error).not.toHaveBeenCalled()
  })

  it("stops at 20 batches, and says so as an error: the drain is not keeping up", async () => {
    notificationBatches(() => BATCH)
    await sweep()
    expect(error).toHaveBeenCalledWith("Pruning notifications could not keep up", { deleted: 100_000, batches: 20, reason: "batches" })
  })

  it("stops after a minute however many batches that is", async () => {
    notificationBatches(() => {
      jest.setSystemTime(Date.now() + 15_000) // each batch takes 15 s
      return BATCH
    })
    await sweep()
    expect(error).toHaveBeenCalledWith("Pruning notifications could not keep up", { deleted: 20_000, batches: 4, reason: "time" })
  })

  it("logs nothing when nothing is stale", async () => {
    notificationBatches(() => 0)
    await sweep()
    expect(info).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it("a batch that throws still reports what went before it, and the other table is still swept", async () => {
    notificationBatches((n) => {
      if (n === 1) throw new Error("canceling statement due to statement timeout")
      return BATCH
    })
    await sweep()
    expect(error).toHaveBeenCalledWith("Pruning notifications failed", {
      deleted: BATCH,
      batches: 1,
      error: "Error: canceling statement due to statement timeout",
    })
    expect(productEventBatches()).toBe(1)
  })

  // Last in this describe: `stopped` is module state, and only the next describe's `start` clears it.
  it("stops between batches when the sweeper is stopped, as a shutdown, not a failure", async () => {
    notificationBatches(() => {
      stopNotificationRetentionSweeper()
      return BATCH
    })
    await sweep()
    expect(info).toHaveBeenCalledWith("Pruned notifications", { deleted: BATCH, batches: 1, reason: "stopped" })
    expect(error).not.toHaveBeenCalled()
    expect(productEventBatches()).toBe(0)
  })
})

describe("one step of the sweep failing", () => {
  it("does not skip the lead purge after it, and the purge's own failure is caught", async () => {
    /*
     * Each step has its own try (SCRUM-431). Without one a throw escapes the
     * sweep's unawaited IIFE as an unhandled rejection, which takes the
     * process down; sharing one lets a deleted-account failure skip the lead
     * purge every pass.
     */
    mockPurgeDeletedAccountRecords.mockRejectedValue(new Error("db blip"))
    mockPurgeLeadPii.mockRejectedValue(new Error("db blip"))
    const errors = jest.spyOn(logger, "error").mockImplementation(() => {})
    const logged = () => errors.mock.calls.some(([message]) => message === "Lead PII purge failed")

    startNotificationRetentionSweeper()
    for (let i = 0; i < 100 && !logged(); i++) await new Promise((r) => setTimeout(r, 10))
    stopNotificationRetentionSweeper()

    expect(mockPurgeLeadPii).toHaveBeenCalled()
    expect(logged()).toBe(true)
    errors.mockRestore()
  })
})
