/*
 * Room lines OpenAI could not check are checked again (moderation-degraded policy).
 *
 * `moderation_status = 'unchecked'` rows were counted on the moderation screen
 * and never revisited, so during an outage they stayed visible for good. The
 * sweeper asks again in a batch and applies the verdict through the live
 * pipeline's own actions.
 */
const mockCheckBatch = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  ...jest.requireActual("@/lib/moderation/openai-moderation"),
  checkTextContents: (...a: unknown[]) => mockCheckBatch(...a),
}))
const hiddenEmits: string[] = []
jest.mock("@/lib/socket-server", () => ({
  ...jest.requireActual("@/lib/socket-server"),
  emitChatMessageHidden: (...a: unknown[]) => void hiddenEmits.push(a[1] as string),
}))

import { RECHECK_BATCH_LIMIT, RECHECK_WINDOW_MS, recheckUncheckedMessages } from "@/lib/moderation-recheck"
import { BREAKER_FAILURES_TO_OPEN, recordTextFailure, recordTextSuccess } from "@/lib/moderation/text-breaker"
import { db, closeDb, makeUser, testId } from "./helpers"

const HIDE = { checked: true, result: { action: "hide", source: "openai_text", categories: { hate: 0.97 }, confidence: 0.97 } }
const FLAG = { checked: true, result: { action: "flag", source: "openai_text", categories: { hate: 0.5 }, confidence: 0.5 } }
const CLEAN = { checked: true, result: null }
const UNCHECKED = { checked: false, reason: "error" }

const users: string[] = []
const events: string[] = []
let groupId = ""
let userId = ""

beforeAll(async () => {
  userId = await makeUser(testId("rc"))
  users.push(userId)
  const owner = await makeUser(testId("rc_own"), "organizer")
  users.push(owner)
  const event = await db.events.create({
    data: {
      slug: testId("rc"),
      title: "recheck fixture",
      description: "integration fixture",
      start_time: new Date(Date.now() - 3_600_000),
      end_time: new Date(Date.now() + 3_600_000),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  groupId = (await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })).id
})

afterAll(async () => {
  await db.moderation_flags.deleteMany({ where: { chat_group_id: groupId } })
  await db.chat_messages.deleteMany({ where: { chat_group_id: groupId } })
  await db.chat_group_members.deleteMany({ where: { chat_group_id: groupId } })
  await db.chat_groups.deleteMany({ where: { id: groupId } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(async () => {
  process.env.OPENAI_API_KEY = "sk-itest"
  recordTextSuccess()
  hiddenEmits.length = 0
  mockCheckBatch.mockReset()
  await db.moderation_flags.deleteMany({ where: { chat_group_id: groupId } })
  await db.chat_messages.deleteMany({ where: { chat_group_id: groupId } })
})

const unchecked = (content: string, extra: { created_at?: Date; deleted_at?: Date } = {}) =>
  db.chat_messages.create({
    data: { chat_group_id: groupId, user_id: userId, content, type: "text", moderation_status: "unchecked", ...extra },
  })
const statusOf = async (id: string) => (await db.chat_messages.findUniqueOrThrow({ where: { id } })).moderation_status

describe("the moderation re-check sweep", () => {
  it("hides, flags and cleans by the verdict, and leaves a row it still cannot check", async () => {
    const [bad, meh, fine, nope] = [await unchecked("bad"), await unchecked("meh"), await unchecked("fine"), await unchecked("nope")]
    mockCheckBatch.mockResolvedValue([HIDE, FLAG, CLEAN, UNCHECKED])

    const out = await recheckUncheckedMessages()

    expect(out).toEqual({ looked: 4, settled: 3 })
    expect(mockCheckBatch).toHaveBeenCalledWith(["bad", "meh", "fine", "nope"])
    expect(await statusOf(bad.id)).toBe("hidden")
    expect((await db.chat_messages.findUniqueOrThrow({ where: { id: bad.id } })).deleted_at).not.toBeNull()
    expect(hiddenEmits).toEqual([bad.id])
    expect(await db.moderation_flags.count({ where: { message_id: bad.id, auto_action: "hidden" } })).toBe(1)
    expect(await statusOf(meh.id)).toBe("flagged")
    expect(await statusOf(fine.id)).toBe("clean")
    expect(await statusOf(nope.id)).toBe("unchecked")
  })

  it("auto-mutes after the third hidden line, as the live pipeline does", async () => {
    await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: userId } })
    for (const c of ["a", "b", "c"]) await unchecked(c)
    mockCheckBatch.mockResolvedValue([HIDE, HIDE, HIDE])
    await recheckUncheckedMessages()
    const member = await db.chat_group_members.findFirstOrThrow({ where: { chat_group_id: groupId, user_id: userId } })
    expect(member.status).toBe("muted")
  })

  it("skips the whole pass while the breaker is open, without asking", async () => {
    await unchecked("waiting")
    for (let i = 0; i < BREAKER_FAILURES_TO_OPEN; i++) recordTextFailure()
    expect(await recheckUncheckedMessages()).toEqual({ looked: 0, settled: 0 })
    expect(mockCheckBatch).not.toHaveBeenCalled()
  })

  it("takes only live, recent, unchecked rows, oldest first, at most one batch", async () => {
    const old = await unchecked("too old", { created_at: new Date(Date.now() - RECHECK_WINDOW_MS - 60_000) })
    const gone = await unchecked("deleted", { deleted_at: new Date() })
    const clean = await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: userId, content: "done", moderation_status: "clean" } })
    const t0 = Date.now() - 10 * 60_000
    for (let i = 0; i < RECHECK_BATCH_LIMIT + 3; i++) await unchecked(`m${String(i).padStart(3, "0")}`, { created_at: new Date(t0 + i * 1000) })
    mockCheckBatch.mockImplementation(async (c: string[]) => c.map(() => UNCHECKED))

    const out = await recheckUncheckedMessages()

    expect(out.looked).toBe(RECHECK_BATCH_LIMIT)
    const asked = mockCheckBatch.mock.calls[0][0] as string[]
    expect(asked[0]).toBe("m000")
    expect(asked).not.toContain("too old")
    expect(asked).not.toContain("deleted")
    expect(asked).not.toContain("done")
    expect([await statusOf(old.id), await statusOf(gone.id), await statusOf(clean.id)]).toEqual(["unchecked", "unchecked", "clean"])
  })

  it("does nothing without a key", async () => {
    await unchecked("x")
    delete process.env.OPENAI_API_KEY
    expect(await recheckUncheckedMessages()).toEqual({ looked: 0, settled: 0 })
    expect(mockCheckBatch).not.toHaveBeenCalled()
  })
})
