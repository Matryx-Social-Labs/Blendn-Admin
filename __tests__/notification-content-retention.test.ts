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

const mockDb = {
  notifications: { findMany: jest.fn(), deleteMany: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

import { storedBodyFor } from "@/lib/push-notifications"
import {
  pruneNotifications,
  READ_RETENTION_DAYS,
  UNREAD_RETENTION_DAYS,
} from "@/lib/notification-retention"

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.notifications.findMany.mockResolvedValue([])
  mockDb.notifications.deleteMany.mockResolvedValue({ count: 0 })
})

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
    const inserts = SRC().match(/db\.notifications\s*\n?\s*\.?(?:create|createMany)\([\s\S]{0,400}?\}\)/g) ?? []
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

    const { where } = mockDb.notifications.findMany.mock.calls[0][0]
    const [readClause, unreadClause] = where.OR

    const readCutoff = readClause.read_at.lt as Date
    const unreadCutoff = unreadClause.created_at.lt as Date

    expect(readClause.read_at.not).toBeNull()
    expect(unreadClause.read_at).toBeNull()
    // The read window is the shorter one, so its cutoff is the later date.
    expect(readCutoff.getTime()).toBeGreaterThan(unreadCutoff.getTime())
  })

  it("is bounded per pass", async () => {
    /*
     * A first run against a table that has never been pruned would otherwise be
     * one unbounded delete over years of rows, taking locks on a table every
     * bell read touches.
     */
    await pruneNotifications(new Date())
    const { take } = mockDb.notifications.findMany.mock.calls[0][0]
    expect(typeof take).toBe("number")
    expect(take).toBeGreaterThan(0)
  })

  it("deletes nothing when nothing is stale", async () => {
    mockDb.notifications.findMany.mockResolvedValue([])
    expect(await pruneNotifications(new Date())).toBe(0)
    expect(mockDb.notifications.deleteMany).not.toHaveBeenCalled()
  })

  it("deletes exactly the rows it selected", async () => {
    mockDb.notifications.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])
    mockDb.notifications.deleteMany.mockResolvedValue({ count: 2 })

    expect(await pruneNotifications(new Date())).toBe(2)
    expect(mockDb.notifications.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] } },
    })
  })
})
