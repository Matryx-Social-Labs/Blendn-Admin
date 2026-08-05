import { sweepExpiredChats } from "@/lib/chat-lifecycle"
import { chatWindowState, CHAT_WINDOW_HOURS } from "@/lib/chat-window"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * The sweep against real rows.
 *
 * Two properties matter more than the happy path:
 *
 *   1. It is idempotent. Both writes filter on the state they are leaving, so a
 *      second pass matches nothing — which is what makes it safe to run from
 *      every replica without coordination and safe to trigger manually while
 *      the timer is also running.
 *   2. It is not load-bearing. Writes are already refused for an expired room
 *      before the sweep has touched it, because `chatWindowState` reads the
 *      event's own end_time. If that ever stops being true, a late or stuck job
 *      silently becomes a hole.
 */

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

async function makeExpiredRoom(opts: { endedHoursAgo: number }) {
  const owner = await makeUser(testId("sweep_owner"), "organizer")
  users.push(owner)
  const slug = testId("sweep")
  const end = new Date(Date.now() - opts.endedHoursAgo * HOUR)
  const event = await db.events.create({
    data: {
      slug,
      title: `Sweep ${slug}`,
      description: "integration fixture",
      start_time: new Date(end.getTime() - 2 * HOUR),
      end_time: end,
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  const group = await db.chat_groups.create({
    data: { event_id: event.id, name: `${slug} chat`, status: "active" },
  })
  return { eventId: event.id, groupId: group.id, endTime: end }
}

afterAll(async () => {
  if (events.length) await db.events.deleteMany({ where: { id: { in: events } } })
  await cleanup(users, [])
  await closeDb()
})

describe("sweepExpiredChats", () => {
  it("archives an expired room and releases its members", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 2 })

    const [active, muted, banned] = await Promise.all([
      makeUser(testId("m_active")),
      makeUser(testId("m_muted")),
      makeUser(testId("m_banned")),
    ])
    users.push(active, muted, banned)
    await db.chat_group_members.createMany({
      data: [
        { chat_group_id: groupId, user_id: active, status: "active" },
        { chat_group_id: groupId, user_id: muted, status: "muted" },
        { chat_group_id: groupId, user_id: banned, status: "banned" },
      ],
    })

    await sweepExpiredChats()

    const group = await db.chat_groups.findUniqueOrThrow({ where: { id: groupId } })
    expect(group.status).toBe("archived")

    const members = await db.chat_group_members.findMany({
      where: { chat_group_id: groupId },
      select: { user_id: true, status: true },
    })
    const byUser = Object.fromEntries(members.map((m) => [m.user_id, m.status]))
    expect(byUser[active]).toBe("left")
    expect(byUser[muted]).toBe("left")
    // A ban is a moderation record and must outlive the room closing.
    expect(byUser[banned]).toBe("banned")
  })

  it("keeps membership rows so historical pseudonyms still resolve", async () => {
    // Deleting members would strip the anonymous names off every past message,
    // which anonymises nobody and breaks the feedback digest.
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 2 })
    const member = await makeUser(testId("m_pseudo"))
    users.push(member)
    await db.chat_group_members.create({
      data: {
        chat_group_id: groupId,
        user_id: member,
        status: "active",
        anonymous_name: "Quiet Otter",
      },
    })

    await sweepExpiredChats()

    const row = await db.chat_group_members.findFirstOrThrow({
      where: { chat_group_id: groupId, user_id: member },
    })
    expect(row.anonymous_name).toBe("Quiet Otter")
  })

  it("leaves a room whose window is still open", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: 1 })
    await sweepExpiredChats()
    const group = await db.chat_groups.findUniqueOrThrow({ where: { id: groupId } })
    expect(group.status).toBe("active")
  })

  it("is idempotent — a second pass changes nothing", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 2 })
    const member = await makeUser(testId("m_idem"))
    users.push(member)
    await db.chat_group_members.create({
      data: { chat_group_id: groupId, user_id: member, status: "active" },
    })

    const first = await sweepExpiredChats()
    expect(first.archived).toBeGreaterThan(0)

    const second = await sweepExpiredChats()
    // Nothing left matching `status: active`, so the second pass is a no-op.
    // This is the property that makes replica duplication safe.
    expect(second.archived).toBe(0)
    expect(second.released).toBe(0)
  })
})

describe("the sweep is not what stops people posting", () => {
  it("refuses writes to an expired room the sweep has not touched yet", async () => {
    // The failure this guards: a stuck or late job silently becoming a hole.
    // The gate reads the event's own end_time, so a room still flagged active
    // is already closed.
    const { groupId, endTime } = await makeExpiredRoom({
      endedHoursAgo: CHAT_WINDOW_HOURS + 5,
    })

    const group = await db.chat_groups.findUniqueOrThrow({ where: { id: groupId } })
    expect(group.status).toBe("active")

    const state = chatWindowState({ end_time: endTime }, group)
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("window_closed")
  })
})
