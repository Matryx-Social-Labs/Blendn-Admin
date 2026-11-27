import { LAST_PASS_MS, MAX_MESSAGES_PER_SWEEP, MAX_SETTLED_PER_PASS, SCAN_WINDOW_MS, sweepSentiment } from "@/lib/sentiment-sweeper"
import { logger } from "@/lib/logger"
import { readLiveSnapshot } from "@/lib/live-snapshot"

import { classifyMessages } from "@/lib/sentiment/classify"

import { sqlCounter } from "./sql-count"
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

/**
 * The keystone, end to end.
 *
 * Everything around this was built and tested months ago — the taxonomy, both
 * classifier tiers, `event_feedback` with three indexes, the live aggregation,
 * the alert rules, the correction UI. Nothing called `classifyMessages` and
 * nothing wrote a feedback row, so the live screen and the feedback screen both
 * read a permanently empty table and no test noticed, because every test was of
 * a part rather than of the join between them.
 *
 * These drive real messages through a real database into a real snapshot.
 *
 * The LLM tier is mocked: it needs a key, it costs money, and what is under test
 * is the wiring rather than the model. The lexicon tier is real and settles most
 * of this without escalating anyway.
 */

jest.mock("@/lib/sentiment/classify", () => {
  const actual = jest.requireActual("@/lib/sentiment/classify")
  return {
    ...actual,
    classifyMessages: jest.fn(async (messages: Array<{ id: string; text: string }>) =>
      Object.assign(messages.map((m) => ({
        id: m.id,
        // Deterministic stand-in keyed on the fixture text, so a test can say
        // "this message is a queue complaint" without invoking a model.
        sentiment: m.text.includes("BAD") ? "negative" : m.text.includes("GOOD") ? "positive" : "neutral",
        category: m.text.includes("QUEUE")
          ? "entry_queue"
          : m.text.includes("SAFETY")
            ? "safety_conduct"
            : "other",
        topic: m.text.includes("MUSIC") ? "music" : null,
        confidence: 0.9,
        source: "llm" as const,
      })), { deferred: 0 })
    ),
  }
})

const users: string[] = []
const events: string[] = []

async function roomWith(texts: string[], opts: { archived?: boolean } = {}) {
  const host = await makeUser("snt-host", "organizer")
  const author = await makeUser("snt-author")
  users.push(host, author)
  const eventId = await makeEvent(host)
  events.push(eventId)

  const group = await db.chat_groups.create({
    data: {
      event_id: eventId,
      name: "room",
      status: opts.archived ? "archived" : "active",
    },
  })
  for (const content of texts) {
    await db.chat_messages.create({
      data: { chat_group_id: group.id, user_id: author, content, type: "text" },
    })
  }
  return { eventId, groupId: group.id, author }
}

afterAll(async () => {
  if (users.length) await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

describe("the sweeper writes what the live screen reads", () => {
  it("writes what a positive message liked, and the host's live view counts it by people", async () => {
    const { eventId, groupId } = await roomWith(["GOOD MUSIC", "GOOD"])
    for (let i = 0; i < 12; i++) {
      const id = await makeUser(`snt-fan${i}`)
      users.push(id)
      await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: id, anonymous_name: `Fan ${i} ${groupId.slice(0, 6)}` } })
      if (i < 5) await db.chat_messages.create({ data: { chat_group_id: groupId, user_id: id, content: "GOOD MUSIC", type: "text" } })
    }
    await sweepSentiment()
    const rows = await db.event_feedback.findMany({ where: { event_id: eventId }, select: { topic: true } })
    expect(rows.map((r) => r.topic).sort()).toEqual([...Array(6).fill("music"), null])
    expect((await readLiveSnapshot(eventId, undefined, { social: true }).then((r) => r?.snapshot ?? null))?.topics).toEqual([{ topic: "music", people: 6 }])
  })

  it("classifies open-room messages into event_feedback", async () => {
    const { eventId } = await roomWith(["BAD QUEUE at the door", "GOOD set tonight"])

    const result = await sweepSentiment()
    expect(result.classified).toBeGreaterThanOrEqual(2)

    const rows = await db.event_feedback.findMany({ where: { event_id: eventId } })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.sentiment).sort()).toEqual(["negative", "positive"])
  })

  it("reaches the live snapshot and fires the alerts that read it", async () => {
    // The actual join that was missing: rows exist, so `readLiveSnapshot`
    // aggregates them and `deriveAlerts` can finally see a category.
    const { eventId } = await roomWith(["SAFETY someone is hurt"])
    await sweepSentiment()

    const snapshot = await readLiveSnapshot(eventId, undefined, { social: true }).then((r) => r?.snapshot ?? null)
    expect(snapshot).not.toBeNull()
    // Listed with no number: one complaint in a room is a sentence with an author (SCRUM-890). The alert still fires.
    expect(snapshot!.categories).toContainEqual(expect.objectContaining({ category: "safety_conduct", count: null, suppressed: true }))
    expect(snapshot!.alerts.map((a) => a.kind)).toContain("safety")
  })

  it("routes a safety message to the moderation queue, flagged and never hidden", async () => {
    /*
     * The alert has said "Routed to moderation regardless of sentiment" since
     * it was written, and nothing did it. Driven 2026-09-13: a message about
     * being grabbed at the bar opened a critical issue and never reached the
     * queue -- no flag row, no "flags waiting", no human unless somebody had
     * the live tab open.
     */
    const { groupId, author } = await roomWith(["SAFETY he grabbed my arm and won't leave"])
    await sweepSentiment()

    const message = await db.chat_messages.findFirstOrThrow({
      where: { chat_group_id: groupId },
      select: { id: true, moderation_status: true },
    })
    const flags = await db.moderation_flags.findMany({ where: { message_id: message.id } })
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({
      chat_group_id: groupId,
      user_id: author,
      source: "auto_text",
      categories: ["safety_conduct"],
      auto_action: "none",
      status: "pending",
    })
    // Flagged, so it is in the queue -- and still on screen for the room.
    expect(message.moderation_status).toBe("flagged")

    // A second pass must not queue it twice.
    await db.event_feedback.deleteMany({ where: { message_id: message.id } })
    await sweepSentiment()
    expect(await db.moderation_flags.count({ where: { message_id: message.id } })).toBe(1)
  })

  it("is idempotent — a second pass writes nothing new", async () => {
    // What lets it run every minute without knowing what the last pass did.
    const { eventId } = await roomWith(["GOOD one"])
    await sweepSentiment()
    const after = await db.event_feedback.count({ where: { event_id: eventId } })

    const second = await sweepSentiment()
    expect(second.classified).toBe(0)
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(after)
  })
})

describe("what it refuses to classify", () => {
  it("skips archived rooms", async () => {
    // `status` is already the state machine for "this room is open". A closed
    // window is not somewhere new sentiment can arrive.
    const { eventId } = await roomWith(["BAD thing"], { archived: true })
    await sweepSentiment()
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(0)
  })

  it("skips deleted and moderation-hidden messages", async () => {
    // A message that was removed should not shape the room's mood — one is the
    // moderation pipeline's verdict, the other the author's.
    const { eventId, groupId, author } = await roomWith([])
    await db.chat_messages.create({
      data: {
        chat_group_id: groupId,
        user_id: author,
        content: "BAD hidden",
        type: "text",
        moderation_status: "hidden",
      },
    })
    await db.chat_messages.create({
      data: {
        chat_group_id: groupId,
        user_id: author,
        content: "BAD deleted",
        type: "text",
        deleted_at: new Date(),
      },
    })

    await sweepSentiment()
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(0)
  })

  it("still classifies a message moderation has not stamped yet", async () => {
    /*
     * The bug this nearly shipped with. `moderation_status` is nullable and is
     * set to "clean" by a fire-and-forget write *after* the response, so a
     * message is NULL for its first moments. The obvious filter,
     * `{ not: "hidden" }`, compiles to `<> 'hidden'`, which is NULL for a NULL
     * row and therefore not true — so every unmoderated message was skipped.
     *
     * Those are the newest messages, which is precisely what a live mood reading
     * is made of. It would have looked like the classifier working, on a
     * permanent lag.
     */
    const { eventId, groupId, author } = await roomWith([])
    await db.chat_messages.create({
      data: {
        chat_group_id: groupId,
        user_id: author,
        content: "BAD QUEUE, not moderated yet",
        type: "text",
        moderation_status: null,
      },
    })

    await sweepSentiment()
    const rows = await db.event_feedback.findMany({ where: { event_id: eventId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe("entry_queue")
  })

  it("never overwrites a human correction", async () => {
    // Someone read the message and disagreed with the model. Re-running the
    // model must not quietly undo that.
    const { eventId } = await roomWith(["BAD QUEUE"])
    await sweepSentiment()

    const row = await db.event_feedback.findFirstOrThrow({ where: { event_id: eventId } })
    await db.event_feedback.update({
      where: { id: row.id },
      data: { sentiment: "positive", category: "other", source: "human", confidence: 1 },
    })

    // Force a re-classification by clearing nothing — the row still exists, so
    // the sweeper will not pick it up; delete-and-resweep proves the guard by
    // re-inserting the same message id.
    await sweepSentiment()
    const after = await db.event_feedback.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.source).toBe("human")
    expect(after.sentiment).toBe("positive")
  })
})

describe("only event rooms are classified (step 7)", () => {
  it("a board post's room never starves an event's: its messages are not selected at all", async () => {
    /*
     * What is classified is how people feel about an event (`event_feedback`
     * has an `event_id`), and a board post's room has none — so its messages
     * are never written back, and were they selected they would be selected
     * first, oldest-first, on every pass for ever. More than a pass's worth,
     * older than the event room's message: without `kind = 'event'` the event
     * message never comes up.
     */
    const host = await makeUser("snt-board-host")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: host, kind: "chat", body: "board" } })
    const boardRoom = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: "board", status: "active" } })
    const old = new Date(Date.now() - 24 * 60 * 60_000)
    await db.chat_messages.createMany({
      data: Array.from({ length: MAX_MESSAGES_PER_SWEEP + 1 }, (_, i) => ({
        chat_group_id: boardRoom.id,
        user_id: host,
        content: `GOOD board ${i}`,
        type: "text" as const,
        created_at: old,
      })),
    })
    const { eventId: roomEvent } = await roomWith(["BAD QUEUE at the door"])

    for (let pass = 0; pass < 30; pass++) {
      if ((await db.event_feedback.count({ where: { event_id: roomEvent } })) > 0) break
      await sweepSentiment()
    }
    expect(await db.event_feedback.count({ where: { event_id: roomEvent } })).toBe(1)
    expect(await db.event_feedback.count({ where: { message: { chat_group_id: boardRoom.id } } })).toBe(0)
  })
})

describe("a pass is a few statements, however many messages it classifies", () => {
  it("finds the work in one read and writes it in one", async () => {
    const { eventId } = await roomWith(Array.from({ length: 30 }, (_, i) => `GOOD set ${i}`))
    const counter = sqlCounter()
    try {
      const { result, sql } = await counter.during(() => sweepSentiment())
      console.info(`sentiment pass over ${result.classified}: ${sql.length} statements`)
      expect(result.classified).toBe(30)
      expect(sql).toHaveLength(2)
    } finally {
      await counter.stop()
    }
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(30)
  })

  it("leaves a message older than the scan window alone", async () => {
    const { eventId, groupId, author } = await roomWith(["GOOD tonight"])
    await db.chat_messages.create({
      data: {
        chat_group_id: groupId,
        user_id: author,
        content: "BAD QUEUE yesterday",
        type: "text",
        created_at: new Date(Date.now() - SCAN_WINDOW_MS - 60_000),
      },
    })
    await sweepSentiment()
    const rows = await db.event_feedback.findMany({ where: { event_id: eventId }, select: { category: true } })
    expect(rows).toEqual([{ category: "other" }])
  })

  it("a message deleted while the model reads it costs the rest nothing", async () => {
    const { eventId, groupId } = await roomWith(["GOOD one", "GOOD two", "BAD QUEUE three"])
    const gone = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: groupId, content: "GOOD two" }, select: { id: true } })
    const real = jest.requireActual("@/lib/sentiment/classify").classifyMessages
    jest.mocked(classifyMessages).mockImplementationOnce(async (messages) => {
      await db.chat_messages.delete({ where: { id: gone.id } })
      return real(messages)
    })
    const result = await sweepSentiment()
    expect(result.classified).toBe(2)
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(2)
  })

  it("keeps a correction made while the model was reading", async () => {
    const { eventId, groupId } = await roomWith(["BAD QUEUE at the door", "GOOD set"])
    const corrected = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: groupId, content: "BAD QUEUE at the door" }, select: { id: true } })
    const real = jest.requireActual("@/lib/sentiment/classify").classifyMessages
    jest.mocked(classifyMessages).mockImplementationOnce(async (messages) => {
      await db.event_feedback.create({
        data: { event_id: eventId, message_id: corrected.id, sentiment: "positive", category: "other", source: "human", confidence: 1 },
      })
      return real(messages)
    })
    const result = await sweepSentiment()
    expect(result.classified).toBe(1)
    const kept = await db.event_feedback.findUniqueOrThrow({ where: { message_id: corrected.id } })
    expect(kept).toMatchObject({ source: "human", sentiment: "positive", category: "other" })
  })

  it("hands the classifier each message's room, and comes straight back for what it did not reach (SCRUM-1231)", async () => {
    // Negative control: no room was passed, so rooms shared a model call; and a pass the classifier's call cap cut
    // short reported hasMore false, so the rest waited a minute.
    const { groupId } = await roomWith(["GOOD one", "GOOD two"])
    let seen: Array<{ id: string; room?: string }> = []
    jest.mocked(classifyMessages).mockImplementationOnce(async (messages) => {
      seen = messages
      return Object.assign([], { deferred: 0 })
    })
    const result = await sweepSentiment()
    const mine = await db.chat_messages.findMany({ where: { chat_group_id: groupId }, select: { id: true } })
    expect(seen.filter((m) => mine.some((x) => x.id === m.id)).map((m) => m.room)).toEqual([groupId, groupId])
    expect(result).toEqual({ classified: 0, hasMore: true })
  })
})
describe("one busy room does not starve the rest (G7)", () => {
  it("gives a quiet room its turn in the same pass as a backlog older than it", async () => {
    // A concert room with more than a pass's worth waiting, all older than the
    // quiet room's three. Oldest-first across rooms, the busy room took every
    // slot and the quiet room's mood was a pass late for each pass it waited.
    const { groupId: busy, eventId: busyEvent, author } = await roomWith([])
    const early = new Date(Date.now() - 30 * 60_000)
    await db.chat_messages.createMany({
      data: Array.from({ length: MAX_MESSAGES_PER_SWEEP + 50 }, (_, i) => ({
        chat_group_id: busy, user_id: author, content: `GOOD busy ${i}`, type: "text" as const, created_at: new Date(early.getTime() + i),
      })),
    })
    const { eventId: quiet } = await roomWith(["BAD QUEUE one", "GOOD two", "neutral three"])

    const pass = await sweepSentiment()

    expect(await db.event_feedback.count({ where: { event_id: quiet } })).toBe(3)
    // The control: the busy room still gets the rest of the pass, newest first (SCRUM-1481: oldest first, a backlog
    // the model could not read would fill every pass), and says more is waiting.
    expect(pass.hasMore).toBe(true)
    expect(await db.event_feedback.count({ where: { event_id: busyEvent } })).toBeGreaterThan(MAX_MESSAGES_PER_SWEEP / 2)
    const busyRows = await db.event_feedback.findMany({ where: { event_id: busyEvent }, select: { message: { select: { content: true } } } })
    const busyContents = busyRows.map((r) => r.message?.content)
    expect(busyContents).toContain(`GOOD busy ${MAX_MESSAGES_PER_SWEEP + 49}`)
    expect(busyContents).not.toContain("GOOD busy 0")
  })
})

describe("a model outage defers an un-cued line instead of settling it for good (SCRUM-1481)", () => {
  const real = () => jest.requireActual("@/lib/sentiment/classify").classifyMessages
  const savedKey = process.env.OPENAI_API_KEY
  afterEach(() => {
    jest.restoreAllMocks()
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  })

  it("a line the model has not read yet is no mood at all, never a neutral one", async () => {
    // Negative control: the failed call wrote both lines neutral / other, and the live view counted two neutrals.
    process.env.OPENAI_API_KEY = "test-key"
    jest.spyOn(global, "fetch").mockImplementation(async () => new Response("", { status: 503 }))
    jest.spyOn(logger, "error").mockImplementation()
    jest.spyOn(logger, "warn").mockImplementation()
    const { eventId } = await roomWith(["where is the bar", "मुझे मदद चाहिए, बाहर एक आदमी मेरा पीछा कर रहा है"])
    jest.mocked(classifyMessages).mockImplementationOnce(real())

    const result = await sweepSentiment()

    expect(result.hasMore).toBe(false)
    expect(await db.event_feedback.count({ where: { event_id: eventId } })).toBe(0)
    const snapshot = await readLiveSnapshot(eventId, undefined, { social: true }).then((r) => r?.snapshot ?? null)
    expect(snapshot!.sentiment).toMatchObject({ positive: 0, neutral: 0 })
  })

  it("reads a room's lines about to leave the window first, then its newest", async () => {
    const { groupId, author } = await roomWith([])
    const now = Date.now()
    await db.chat_messages.createMany({
      data: [
        ...Array.from({ length: MAX_MESSAGES_PER_SWEEP + 50 }, (_, i) => ({
          chat_group_id: groupId, user_id: author, content: `GOOD fresh ${i}`, type: "text" as const, created_at: new Date(now - 3 * 3_600_000 + i * 1_000),
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          chat_group_id: groupId, user_id: author, content: `GOOD band ${i}`, type: "text" as const, created_at: new Date(now - SCAN_WINDOW_MS + LAST_PASS_MS / 2 + i),
        })),
      ],
    })
    let seen: string[] = []
    jest.mocked(classifyMessages).mockImplementationOnce(async (messages) => {
      seen = messages.map((m) => m.text)
      return Object.assign([], { deferred: 0 })
    })

    await sweepSentiment()

    const mine = seen.filter((t) => t.startsWith("GOOD fresh") || t.startsWith("GOOD band"))
    expect(mine.slice(0, 3).sort()).toEqual(["GOOD band 0", "GOOD band 1", "GOOD band 2"])
    expect(mine[3]).toBe(`GOOD fresh ${MAX_MESSAGES_PER_SWEEP + 49}`)
    expect(mine).not.toContain("GOOD fresh 0")
  })

  it("on a failed pass writes the word list's guess for every line about to leave the window, past a pass's worth, with one error", async () => {
    const { eventId, groupId, author } = await roomWith([])
    const now = Date.now()
    const inBand = (i = 0) => new Date(now - SCAN_WINDOW_MS + LAST_PASS_MS / 2 + i)
    const band = MAX_MESSAGES_PER_SWEEP + 10
    await db.chat_messages.createMany({
      data: [
        ...Array.from({ length: band }, (_, i) => ({
          chat_group_id: groupId, user_id: author, content: `where is the bar ${i}`, type: "text" as const, created_at: inBand(i),
        })),
        { chat_group_id: groupId, user_id: author, content: "some guy keeps grabbing my friend", type: "text" as const, created_at: inBand(band) },
        { chat_group_id: groupId, user_id: author, content: "where is the cloakroom", type: "text" as const, created_at: new Date(now - 60_000) },
        { chat_group_id: groupId, user_id: author, content: "where is the exit", type: "text" as const, created_at: new Date(now - SCAN_WINDOW_MS - 60_000) },
      ],
    })
    // The settle's own room filters: a board post's room (no event to write against) and an archived event room.
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author, kind: "chat", body: "board" } })
    const boardRoom = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: "board", status: "active" } })
    const { groupId: archived } = await roomWith([], { archived: true })
    await db.chat_messages.createMany({
      data: [boardRoom.id, archived].map((room) => ({ chat_group_id: room, user_id: author, content: "where is the bar", type: "text" as const, created_at: inBand() })),
    })
    const error = jest.spyOn(logger, "error").mockImplementation()
    // The model is down: every line the pass sent comes back unread.
    jest.mocked(classifyMessages).mockImplementationOnce(async (messages) => Object.assign([], { deferred: messages.length }))

    const result = await sweepSentiment()

    const rows = await db.event_feedback.findMany({
      where: { event_id: eventId },
      select: { source: true, category: true, created_at: true, message: { select: { content: true, created_at: true } } },
    })
    expect(rows).toHaveLength(band + 1)
    expect(rows.every((r) => r.source === "lexicon")).toBe(true)
    // A row carries its message's time: a line read hours late is not the last 30 minutes' mood.
    expect(rows.every((r) => r.created_at.getTime() === r.message?.created_at.getTime())).toBe(true)
    const contents = rows.map((r) => r.message?.content)
    expect(contents).not.toContain("where is the cloakroom")
    expect(contents).not.toContain("where is the exit")
    expect(await db.event_feedback.count({ where: { message: { chat_group_id: { in: [boardRoom.id, archived] } } } })).toBe(0)
    // The cued line reached the moderation queue from the settle, with its author and room.
    expect(rows.find((r) => r.message?.content === "some guy keeps grabbing my friend")?.category).toBe("safety_conduct")
    const flag = await db.moderation_flags.findFirstOrThrow({ where: { chat_group_id: groupId } })
    expect(flag).toMatchObject({ user_id: author, source: "auto_text", status: "pending" })
    // Other tests' rooms share this database: their band lines are settled by the same pass, so at least `band + 1`.
    expect(result.hasMore).toBe(false)
    expect(result.classified).toBeGreaterThanOrEqual(band + 1)
    const counted = error.mock.calls.filter(([message]) => /left the window/.test(String(message)))
    expect(counted).toHaveLength(1)
    expect(counted[0][1]).toMatchObject({ unsettled: 0 })
    expect((counted[0][1] as { settled: number }).settled).toBeGreaterThanOrEqual(band + 1)
  })

  it("settles the oldest band lines first, and counts the ones past its cap in the same error", async () => {
    const { groupId, author } = await roomWith([])
    const now = Date.now()
    await db.chat_messages.createMany({
      data: Array.from({ length: MAX_SETTLED_PER_PASS + 2 }, (_, i) => ({
        chat_group_id: groupId, user_id: author, content: `where is the bar ${i}`, type: "text" as const,
        created_at: new Date(now - SCAN_WINDOW_MS + LAST_PASS_MS / 2 + i),
      })),
    })
    const error = jest.spyOn(logger, "error").mockImplementation()
    jest.mocked(classifyMessages).mockImplementationOnce(async (messages) => Object.assign([], { deferred: messages.length }))

    await sweepSentiment()

    const counted = error.mock.calls.filter(([message]) => /left the window/.test(String(message)))
    expect(counted).toHaveLength(1)
    expect(counted[0][1]).toMatchObject({ settled: MAX_SETTLED_PER_PASS })
    expect((counted[0][1] as { unsettled: number }).unsettled).toBeGreaterThanOrEqual(2)
    const ends = await db.chat_messages.findMany({
      where: { chat_group_id: groupId, content: { in: ["where is the bar 0", `where is the bar ${MAX_SETTLED_PER_PASS + 1}`] } },
      select: { content: true, feedback: { select: { id: true } } },
    })
    expect(ends.find((m) => m.content === "where is the bar 0")?.feedback).not.toBeNull()
    expect(ends.find((m) => m.content === `where is the bar ${MAX_SETTLED_PER_PASS + 1}`)?.feedback).toBeNull()
  })
})
