import { loopClosure } from "@/lib/loop-closure"

import {
  cleanup,
  closeDb,
  db,
  makeEvent,
  makeUser,
  occurrenceOf,
  putInRoom,
  testId,
} from "./helpers"

/**
 * The loop: signed up → onboarded → RSVP'd → checked in → matched → conversed
 * → came back.
 *
 * ## Golden numbers, hand-verified
 *
 * Every person below is built to land on exactly one stage, so the expected
 * counts are readable from the fixture rather than derived from the query. That
 * is the point: a funnel test that recomputes the funnel proves only that the
 * code equals itself.
 *
 * ## Against real Postgres, because the query is the thing
 *
 * It is one `FILTER` aggregate with a self-join for the mutual like and a
 * `COUNT(DISTINCT event_id)` for the return. None of that survives a mock, and
 * the two defects it is written to avoid — a stage that is not a subset of the
 * one above, and a row count standing in for a person count — are both
 * invisible to `tsc`.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.private_messages.deleteMany({ where: { sender_id: { in: users } } })
    await db.private_conversations.deleteMany({
      where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] },
    })
    await db.event_likes.deleteMany({ where: { liker_id: { in: users } } })
    await db.event_rsvps.deleteMany({ where: { user_id: { in: users } } })
  }
  await cleanup(users, events)
  await closeDb()
})

/**
 * The funnel counts every non-deleted user on the platform, so a shared test
 * database has rows this fixture did not create. Each assertion is therefore a
 * **delta** against a baseline taken before the fixture is built — which is
 * also the honest way to assert on a cumulative figure.
 */
async function baseline() {
  return (await loopClosure()).map((s) => s.value)
}

const delta = (after: number[], before: number[]) => after.map((v, i) => v - before[i])

async function onboardedUser(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  // `makeUser` creates the User row and not the profile — the two are separate
  // models joined on id, so `onboarded` has nowhere to live until this runs.
  await db.profiles.upsert({
    where: { id },
    create: { id, onboarded: true },
    update: { onboarded: true },
  })
  return id
}

describe("the loop, stage by stage", () => {
  it("counts a person at exactly the stage they reached", async () => {
    const before = await baseline()

    const host = await makeUser(testId("lc-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)

    // 1. Signed up, nothing else.
    const justSignedUp = await makeUser(testId("lc-signed"))
    users.push(justSignedUp)

    // 2. Onboarded, no RSVP.
    await onboardedUser("lc-onboarded")

    // 3. RSVP'd, never turned up.
    const rsvpOnly = await onboardedUser("lc-rsvp")
    await db.event_rsvps.create({
      data: { event_id: eventId, user_id: rsvpOnly, status: "going" },
    })

    // 4. Checked in, never matched.
    const checkedIn = await onboardedUser("lc-checkedin")
    await db.event_rsvps.create({
      data: { event_id: eventId, user_id: checkedIn, status: "going" },
    })
    await putInRoom({ eventId, occurrenceId, userId: checkedIn })

    // 5. Matched — a MUTUAL pair — and never wrote a word.
    const matchedA = await onboardedUser("lc-matched-a")
    const matchedB = await onboardedUser("lc-matched-b")
    for (const u of [matchedA, matchedB]) {
      await db.event_rsvps.create({ data: { event_id: eventId, user_id: u, status: "going" } })
      await putInRoom({ eventId, occurrenceId, userId: u })
    }
    await db.event_likes.createMany({
      data: [
        { event_id: eventId, liker_id: matchedA, liked_id: matchedB },
        { event_id: eventId, liker_id: matchedB, liked_id: matchedA },
      ],
    })

    const after = await baseline()
    const [signedUp, onboarded, rsvpd, checkedInCount, matched, conversed, returned] = delta(
      after,
      before
    )

    // host + justSignedUp + onboarded + rsvpOnly + checkedIn + matchedA + matchedB
    expect(signedUp).toBe(7)
    // Everyone except the host and justSignedUp.
    expect(onboarded).toBe(5)
    expect(rsvpd).toBe(4)
    expect(checkedInCount).toBe(3)
    expect(matched).toBe(2)
    // Nobody wrote anything, and nobody attended twice.
    expect(conversed).toBe(0)
    expect(returned).toBe(0)
  })

  it("does not count a one-sided like as a match", async () => {
    /*
     * There is no `matches` table — the mutual check runs on every like and is
     * never stored — so this stage is a self-join. Counting a single like would
     * report an approach as a connection, which is the one thing this product
     * measures itself on.
     */
    const before = await baseline()

    const host = await makeUser(testId("lc1-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)

    const admirer = await onboardedUser("lc1-admirer")
    const admired = await onboardedUser("lc1-admired")
    for (const u of [admirer, admired]) {
      await db.event_rsvps.create({ data: { event_id: eventId, user_id: u, status: "going" } })
      await putInRoom({ eventId, occurrenceId, userId: u })
    }
    await db.event_likes.create({
      data: { event_id: eventId, liker_id: admirer, liked_id: admired },
    })

    const [, , , checkedIn, matched] = delta(await baseline(), before)
    expect(checkedIn).toBe(2)
    expect(matched).toBe(0)
  })

  it("counts a conversation only when somebody wrote in it", async () => {
    /*
     * A match that opens a conversation neither person writes in has not closed
     * the loop. Counting the row would say it had — and every match opens one,
     * so that mistake would make `conversed` a copy of `matched`.
     */
    const before = await baseline()

    const host = await makeUser(testId("lc2-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)

    const speaker = await onboardedUser("lc2-speaker")
    const listener = await onboardedUser("lc2-listener")
    for (const u of [speaker, listener]) {
      await db.event_rsvps.create({ data: { event_id: eventId, user_id: u, status: "going" } })
      await putInRoom({ eventId, occurrenceId, userId: u })
    }
    await db.event_likes.createMany({
      data: [
        { event_id: eventId, liker_id: speaker, liked_id: listener },
        { event_id: eventId, liker_id: listener, liked_id: speaker },
      ],
    })
    const [user1_id, user2_id] = [speaker, listener].sort()
    const conversation = await db.private_conversations.create({
      data: { user1_id, user2_id },
      select: { id: true },
    })
    await db.private_messages.create({
      data: { conversation_id: conversation.id, sender_id: speaker, message_text: "hello" },
    })

    const [, , , , matched, conversed] = delta(await baseline(), before)
    expect(matched).toBe(2)
    // Only the one who wrote.
    expect(conversed).toBe(1)
  })

  it("counts a multi-day event once, not once per day", async () => {
    /*
     * THE assertion this table invites getting wrong. One person at one
     * three-day conference has three check-in rows, and counting rows made them
     * a returning attendee — the defect W17 fixed in nine places, waiting to be
     * reintroduced by anybody who counts this fresh.
     *
     * `came back` is COUNT(DISTINCT event_id) >= 2, so three days at one event
     * is not a return and two days at two events is.
     */
    const before = await baseline()

    const host = await makeUser(testId("lc3-host"), "organizer")
    users.push(host)
    const first = await makeEvent(host)
    const second = await makeEvent(host)
    events.push(first, second)

    /*
     * Both are carried all the way to `conversed`, because the stages are
     * nested: `came back` is a subset of `conversed`, so anybody stopping short
     * of it would be filtered out before the return is ever examined and the
     * assertion would pass for the wrong reason.
     */
    const loyal = await onboardedUser("lc3-loyal")
    const conference = await onboardedUser("lc3-conf")
    for (const u of [loyal, conference]) {
      await db.event_rsvps.create({ data: { event_id: first, user_id: u, status: "going" } })
      await db.event_likes.createMany({
        data: [
          { event_id: first, liker_id: u, liked_id: host },
          { event_id: first, liker_id: host, liked_id: u },
        ],
      })
      const [user1_id, user2_id] = [u, host].sort()
      const conversation = await db.private_conversations.create({
        data: { user1_id, user2_id },
        select: { id: true },
      })
      await db.private_messages.create({
        data: { conversation_id: conversation.id, sender_id: u, message_text: "hi" },
      })
    }

    // The loyal one: two different events.
    await putInRoom({ eventId: first, occurrenceId: await occurrenceOf(first), userId: loyal })
    await putInRoom({ eventId: second, occurrenceId: await occurrenceOf(second), userId: loyal })

    /*
     * The conference-goer: three rows, one event. Not a return.
     *
     * Three *occurrences*, because `@@unique([occurrence_id, user_id])` is what
     * makes a multi-day event one row per person per day — which is precisely
     * the shape that made somebody who went to one conference look like a
     * returning attendee. The fixture has to reproduce it faithfully or the
     * assertion is about nothing.
     */
    const day1 = await occurrenceOf(first)
    const dayIds = [day1]
    for (let day = 1; day < 3; day++) {
      const occursOn = new Date(Date.now() + day * 86_400_000)
      const extra = await db.event_occurrences.create({
        data: {
          event_id: first,
          occurs_on: new Date(occursOn.toISOString().slice(0, 10)),
          start_time: occursOn,
          end_time: new Date(occursOn.getTime() + 3 * 60 * 60 * 1000),
        },
        select: { id: true },
      })
      dayIds.push(extra.id)
    }
    for (const [day, occurrenceId] of dayIds.entries()) {
      await db.event_check_ins.create({
        data: {
          event_id: first,
          occurrence_id: occurrenceId,
          user_id: conference,
          kind: "attendee",
          status: "checked_out",
          check_in_time: new Date(Date.now() + day * 86_400_000),
        },
      })
    }

    const [, , , , matched, conversed, returned] = delta(await baseline(), before)
    // Both reached the stage above; only one of them came back.
    expect(matched).toBe(2)
    expect(conversed).toBe(2)
    expect(returned).toBe(1)
  })
})
