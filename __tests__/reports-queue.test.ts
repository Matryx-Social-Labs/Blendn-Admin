/*
 * A report reaching a human, and what the human can do about it.
 *
 * `user_reports`, `message_reports` and `event_reports` were written by mobile
 * routes and
 * read by nothing at all — so the tests that matter here are less about
 * rendering and more about the decisions: who may take them, what they write,
 * and which ones a row is even allowed to offer.
 */
const tx = {
  user_reports: { update: jest.fn() },
  message_reports: { update: jest.fn() },
  event_reports: { update: jest.fn() },
  chat_messages: { update: jest.fn() },
  user: { update: jest.fn() },
  mobile_refresh_tokens: { updateMany: jest.fn() },
  push_tokens: { deleteMany: jest.fn() },
  chat_group_members: { updateMany: jest.fn() },
}

const mockDb = {
  user_reports: { findMany: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
  message_reports: { findMany: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
  event_reports: { findMany: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
  chat_messages: { findMany: jest.fn(), findUnique: jest.fn() },
  private_messages: { findMany: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn(),
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

const mockAuditLog = jest.fn()
jest.mock("@/lib/audit-log", () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }))

const emitChatMessageHidden = jest.fn()
jest.mock("@/lib/socket-server", () => ({ emitChatMessageHidden }))

import { getReportQueue, resolveReport } from "@/app/dashboard/moderation/reports/actions"

const T0 = new Date("2026-08-10T12:00:00.000Z")

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "app_admin" } })
  mockDb.user_reports.findMany.mockResolvedValue([])
  mockDb.message_reports.findMany.mockResolvedValue([])
  mockDb.event_reports.findMany.mockResolvedValue([])
  mockDb.user_reports.groupBy.mockResolvedValue([])
  mockDb.message_reports.groupBy.mockResolvedValue([])
  mockDb.event_reports.groupBy.mockResolvedValue([])
  mockDb.chat_messages.findMany.mockResolvedValue([])
  mockDb.private_messages.findMany.mockResolvedValue([])
  mockDb.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
})

describe("getReportQueue", () => {
  it("refuses anyone who is not a platform admin", async () => {
    // A server action is a POST endpoint dispatched by action id, with the page
    // component nowhere in the path — the page's redirect guards the view, not
    // this. And this returns private message content beside real names.
    mockAuth.mockResolvedValue({ user: { id: "o1", role: "organizer" } })
    await expect(getReportQueue()).rejects.toThrow(/not authorised/i)
    expect(mockDb.user_reports.findMany).not.toHaveBeenCalled()
  })

  it("returns both kinds in one queue, oldest first", async () => {
    mockDb.user_reports.findMany.mockResolvedValue([
      {
        id: "ur1",
        created_at: new Date(T0.getTime() - 60 * 60 * 1000),
        reason: "harassment",
        description: null,
        reviewed_by: null,
        reporter: { name: "Reporter", email: "r@b.com" },
        reported: { id: "u9", name: "Subject", email: "s@b.com", suspended_at: null },
      },
    ])
    mockDb.message_reports.findMany.mockResolvedValue([
      {
        id: "mr1",
        created_at: new Date(T0.getTime() - 10 * 60 * 60 * 1000),
        reason: "abuse",
        description: "said something vile",
        message_id: "m1",
        message_type: "group",
        reviewed_by: null,
        reporter: { name: "Reporter", email: "r@b.com" },
      },
    ])
    mockDb.chat_messages.findMany.mockResolvedValue([
      {
        id: "m1",
        content: "vile thing",
        deleted_at: null,
        user: { id: "u8", name: "Author", email: "a@b.com", suspended_at: null },
        chat_group: { event_id: "e1", event: { title: "Techno Tuesday" } },
      },
    ])

    const { rows } = await getReportQueue()
    expect(rows.map((r) => r.id)).toEqual(["mr1", "ur1"])
    expect(rows[0].excerpt).toBe("vile thing")
    expect(rows[0].eventTitle).toBe("Techno Tuesday")
    expect(rows[1].kind).toBe("user")
  })

  it("resolves a reported message's author across both message tables", async () => {
    // `message_id` carries no foreign key — it points at one of two tables,
    // discriminated by `message_type` — so nothing resolves the author for us.
    mockDb.message_reports.findMany.mockResolvedValue([
      {
        id: "mr2",
        created_at: T0,
        reason: "abuse",
        description: null,
        message_id: "p1",
        message_type: "private",
        reviewed_by: null,
        reporter: { name: "R", email: "r@b.com" },
      },
    ])
    mockDb.private_messages.findMany.mockResolvedValue([
      {
        id: "p1",
        message_text: "a DM",
        sender: { id: "u7", name: "DM Author", email: "d@b.com", suspended_at: new Date() },
      },
    ])

    const [row] = (await getReportQueue()).rows
    expect(row.subjectId).toBe("u7")
    expect(row.subjectName).toBe("DM Author")
    expect(row.subjectSuspended).toBe(true)
    expect(row.messageType).toBe("private")
  })

  it("survives a message deleted between the report and the review", async () => {
    // The row still has to render, and it has to say the message is gone rather
    // than show an empty quotation.
    mockDb.message_reports.findMany.mockResolvedValue([
      {
        id: "mr3",
        created_at: T0,
        reason: "abuse",
        description: null,
        message_id: "gone",
        message_type: "group",
        reviewed_by: null,
        reporter: { name: "R", email: "r@b.com" },
      },
    ])

    const [row] = (await getReportQueue()).rows
    expect(row.excerpt).toBeNull()
    expect(row.subjectId).toBeNull()
    expect(row.subjectName).toBe("Deleted account")
  })

  it("counts both tables into one per-status total", async () => {
    mockDb.user_reports.groupBy.mockResolvedValue([{ status: "pending", _count: { _all: 3 } }])
    mockDb.message_reports.groupBy.mockResolvedValue([{ status: "pending", _count: { _all: 4 } }])
    expect((await getReportQueue()).counts.pending).toBe(7)
  })
})

describe("resolveReport", () => {
  const pendingUserReport = { id: "ur1", status: "pending", reported_id: "u9" }
  const pendingGroupReport = {
    id: "mr1",
    status: "pending",
    message_id: "m1",
    message_type: "group",
  }

  it("refuses anyone who is not a platform admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "o1", role: "organizer" } })
    await expect(resolveReport("user", "ur1", "suspend")).rejects.toThrow(/only platform admins/i)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("refuses a report another admin already actioned", async () => {
    // Two people working the queue at once would otherwise both act on it, and
    // the second click would suspend an account for a report already dismissed.
    mockDb.user_reports.findUnique.mockResolvedValue({ ...pendingUserReport, status: "resolved" })
    await expect(resolveReport("user", "ur1", "suspend")).rejects.toThrow(/already been reviewed/i)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("suspending reaches every channel a suspended person could still act through", async () => {
    /*
     * This test used to assert `session.deleteMany()` and pass — against a
     * statement that could never do anything, because the strategy is `jwt` and
     * there are no `Session` rows. So the test agreed with the code and both
     * were wrong, while the reviewer's UI said suspension "blocks the account
     * everywhere and signs it out".
     *
     * Four channels now, and the assertion names each one, because "everywhere"
     * is only checkable as a list. `__tests__/suspension-blast-radius.test.ts`
     * holds the other half: the four gates that have to read it.
     */
    mockDb.user_reports.findUnique.mockResolvedValue(pendingUserReport)
    await resolveReport("user", "ur1", "suspend")

    // The fact.
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u9" },
        data: expect.objectContaining({ suspended_by: "admin1" }),
      })
    )
    // No new app session. Access tokens are verified without a database read,
    // so without this a suspended account keeps signing in for thirty days.
    expect(tx.mobile_refresh_tokens.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: "u9", revoked_at: null } })
    )
    // No notifications.
    expect(tx.push_tokens.deleteMany).toHaveBeenCalledWith({ where: { user_id: "u9" } })
    // No posting, in any room.
    expect(tx.chat_group_members.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ user_id: "u9" }),
        data: { status: "banned" },
      })
    )
  })

  it("dismissing records that a human looked and did nothing", async () => {
    mockDb.user_reports.findUnique.mockResolvedValue(pendingUserReport)
    await resolveReport("user", "ur1", "dismiss")

    expect(tx.user_reports.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "reviewed", reviewed_by: "admin1" }),
      })
    )
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it("separates 'looked at' from 'acted on' in the status", async () => {
    // `reviewed` and `resolved` are the difference between "we found nothing"
    // and "we removed it" — the question that gets asked six weeks later.
    mockDb.message_reports.findUnique.mockResolvedValue(pendingGroupReport)
    await resolveReport("message", "mr1", "remove_message")
    expect(tx.message_reports.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "resolved" }) })
    )
    expect(tx.chat_messages.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m1" } })
    )
  })

  it("tells the room a removed message is gone", async () => {
    /*
     * Driven from a phone: the report landed, the admin pressed Remove, the
     * row got `deleted_at`, and the message stayed on the reporter's screen
     * until the next reload. The flag queue's twin already emitted; this did
     * not.
     */
    mockDb.message_reports.findUnique.mockResolvedValue(pendingGroupReport)
    mockDb.chat_messages.findUnique.mockResolvedValue({ user_id: "u9", chat_group_id: "g1" })
    await resolveReport("message", "mr1", "remove_message")
    expect(emitChatMessageHidden).toHaveBeenCalledWith("g1", "m1", "u9")
    expect(tx.chat_messages.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deleted_by: "admin1" }) })
    )
  })

  it("will not try to remove a private message", async () => {
    // `private_messages` has no `deleted_at`, so there is nothing to set. The
    // button is hidden for DMs; this is the server refusing to be asked anyway.
    mockDb.message_reports.findUnique.mockResolvedValue({
      ...pendingGroupReport,
      message_type: "private",
    })
    await expect(resolveReport("message", "mr1", "remove_message")).rejects.toThrow(
      /group room/i
    )
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("will not suspend when the reported message no longer exists", async () => {
    // Fails loudly rather than suspending whoever `null` resolves to.
    mockDb.message_reports.findUnique.mockResolvedValue(pendingGroupReport)
    mockDb.chat_messages.findUnique.mockResolvedValue(null)
    await expect(resolveReport("message", "mr1", "suspend")).rejects.toThrow(/no longer exists/i)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("reinstating clears the suspension", async () => {
    mockDb.user_reports.findUnique.mockResolvedValue(pendingUserReport)
    await resolveReport("user", "ur1", "reinstate")
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u9" },
      data: { suspended_at: null, suspended_by: null },
    })
  })

  it("reinstating works on a report that was already resolved — that is when it is offered", async () => {
    /*
     * The table offers Reinstate only on resolved rows ("a suspension that can
     * only be reversed by an engineer with database access is not reversible
     * in any sense the product can rely on"), and the already-reviewed guard
     * refused exactly that row — every Reinstate 500'd. Found by suspending
     * someone and trying to undo it.
     */
    mockDb.user_reports.findUnique.mockResolvedValue({ ...pendingUserReport, status: "resolved" })
    await resolveReport("user", "ur1", "reinstate")
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u9" },
      data: { suspended_at: null, suspended_by: null },
    })
    // The report's own verdict stands; only the suspension is lifted.
    expect(tx.user_reports.update).not.toHaveBeenCalled()
  })

  it("writes every decision to the audit log", async () => {
    mockDb.user_reports.findUnique.mockResolvedValue(pendingUserReport)
    await resolveReport("user", "ur1", "suspend")
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin1",
        action: "report.suspend",
        resource: "user_report",
        resourceId: "ur1",
      })
    )
  })
})
