import { getEventAttendance } from "@/lib/attendance"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * Who came, and who came back.
 *
 * The interesting cases are the awkward ones: a person who attends day 1 and
 * day 3 but not day 2 is still "returning" on day 3, and a cancelled day is not
 * a day nobody came to. Getting either wrong makes the retention number quietly
 * wrong, which is worse than not having it.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

/** An event with `dayCount` consecutive days. */
async function multiDay(dayCount: number) {
  const owner = await makeUser(testId("at_own"), "organizer")
  users.push(owner)
  const start = new Date("2026-09-01T09:00:00Z")
  const event = await db.events.create({
    data: {
      slug: testId("at"),
      title: "Attendance fixture",
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + (dayCount - 1) * 86_400_000 + 9 * 3_600_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: owner,
    },
  })
  events.push(event.id)

  const occurrences = []
  for (let i = 0; i < dayCount; i++) {
    const day = new Date(start.getTime() + i * 86_400_000)
    occurrences.push(
      await db.event_occurrences.create({
        data: {
          event_id: event.id,
          occurs_on: new Date(day.toISOString().slice(0, 10)),
          start_time: day,
          end_time: new Date(day.getTime() + 9 * 3_600_000),
        },
      })
    )
  }
  return { eventId: event.id, occurrences }
}

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  return id
}

async function attend(
  eventId: string,
  occurrenceId: string,
  userId: string,
  kind: "attendee" | "staff" = "attendee"
) {
  await db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: occurrenceId,
      user_id: userId,
      kind,
      status: "checked_out",
      check_in_time: new Date(),
    },
  })
}

describe("single-day events", () => {
  it("reports one honest number, not an empty chart", async () => {
    // The common case by far. A five-column chart with one bar would be worse
    // than a number.
    const { eventId, occurrences } = await multiDay(1)
    await attend(eventId, occurrences[0].id, await person("s1"))
    await attend(eventId, occurrences[0].id, await person("s2"))

    const a = await getEventAttendance(eventId)
    expect(a.singleDay).toBe(true)
    expect(a.uniqueTotal).toBe(2)
    expect(a.days).toHaveLength(1)
    // No second day to return on.
    expect(a.retentionPct).toBeNull()
  })
})

describe("new versus returning", () => {
  it("counts everyone as new on day one", async () => {
    const { eventId, occurrences } = await multiDay(3)
    for (const l of ["n1", "n2"]) await attend(eventId, occurrences[0].id, await person(l))

    const a = await getEventAttendance(eventId)
    expect(a.days[0].newcomers).toBe(2)
    expect(a.days[0].returning).toBe(0)
  })

  it("counts a repeat visitor as returning, not new", async () => {
    const { eventId, occurrences } = await multiDay(3)
    const loyal = await person("loyal")
    await attend(eventId, occurrences[0].id, loyal)
    await attend(eventId, occurrences[1].id, loyal)

    const a = await getEventAttendance(eventId)
    expect(a.days[1].returning).toBe(1)
    expect(a.days[1].newcomers).toBe(0)
    // One person, two days.
    expect(a.uniqueTotal).toBe(1)
  })

  it("handles a GAP day — attends 1 and 3, not 2", async () => {
    // The case naive "did they come yesterday" logic gets wrong. They are
    // returning on day 3, not new.
    const { eventId, occurrences } = await multiDay(3)
    const skipper = await person("skipper")
    await attend(eventId, occurrences[0].id, skipper)
    await attend(eventId, occurrences[2].id, skipper)

    const a = await getEventAttendance(eventId)
    expect(a.days[1].unique).toBe(0)
    expect(a.days[2].returning).toBe(1)
    expect(a.days[2].newcomers).toBe(0)
  })

  it("splits a mixed day correctly", async () => {
    const { eventId, occurrences } = await multiDay(2)
    const loyal = await person("mix_loyal")
    await attend(eventId, occurrences[0].id, loyal)
    await attend(eventId, occurrences[1].id, loyal)
    await attend(eventId, occurrences[1].id, await person("mix_new"))

    const a = await getEventAttendance(eventId)
    expect(a.days[1].unique).toBe(2)
    expect(a.days[1].returning).toBe(1)
    expect(a.days[1].newcomers).toBe(1)
  })
})

describe("staff never appear", () => {
  it("excludes crew from every attendance number", async () => {
    // Crew attend every day and would otherwise dominate "returning", turning
    // the most useful figure on the screen into a headcount of the staff.
    const { eventId, occurrences } = await multiDay(2)
    const crew = await person("at_crew")
    await attend(eventId, occurrences[0].id, crew, "staff")
    await attend(eventId, occurrences[1].id, crew, "staff")
    await attend(eventId, occurrences[0].id, await person("at_guest"))

    const a = await getEventAttendance(eventId)
    expect(a.uniqueTotal).toBe(1)
    expect(a.days[0].unique).toBe(1)
    expect(a.days[1].unique).toBe(0)
  })
})

describe("cancelled days", () => {
  it("is not counted as a day nobody came to", async () => {
    const { eventId, occurrences } = await multiDay(3)
    await db.event_occurrences.update({
      where: { id: occurrences[1].id },
      data: { cancelled_at: new Date() },
    })
    const loyal = await person("c_loyal")
    await attend(eventId, occurrences[0].id, loyal)
    await attend(eventId, occurrences[2].id, loyal)

    const a = await getEventAttendance(eventId)
    expect(a.days[1].cancelled).toBe(true)
    // Retention spans the days that ran: day 1 to day 3.
    expect(a.retentionPct).toBe(100)
  })

  it("does not let a cancelled day make an event look multi-day", async () => {
    const { eventId, occurrences } = await multiDay(2)
    await db.event_occurrences.update({
      where: { id: occurrences[1].id },
      data: { cancelled_at: new Date() },
    })
    const a = await getEventAttendance(eventId)
    expect(a.singleDay).toBe(true)
  })
})

describe("retention", () => {
  it("measures day one's guests against the last day", async () => {
    const { eventId, occurrences } = await multiDay(2)
    const stayed = await person("r_stay")
    const left = await person("r_left")
    await attend(eventId, occurrences[0].id, stayed)
    await attend(eventId, occurrences[0].id, left)
    await attend(eventId, occurrences[1].id, stayed)

    const a = await getEventAttendance(eventId)
    expect(a.retentionPct).toBe(50)
  })

  it("is null when nobody came on day one", async () => {
    // Zero of zero is not zero percent; it is nothing to report.
    const { eventId, occurrences } = await multiDay(2)
    await attend(eventId, occurrences[1].id, await person("r_late"))
    const a = await getEventAttendance(eventId)
    expect(a.retentionPct).toBeNull()
  })
})

describe("turn-up", () => {
  it("measures attendance against people who said they were coming", async () => {
    const { eventId, occurrences } = await multiDay(1)
    const going = await person("t_going")
    const noShow = await person("t_noshow")
    await db.event_rsvps.createMany({
      data: [
        { event_id: eventId, user_id: going, status: "going" },
        { event_id: eventId, user_id: noShow, status: "going" },
      ],
    })
    await attend(eventId, occurrences[0].id, going)

    const a = await getEventAttendance(eventId)
    expect(a.going).toBe(2)
    expect(a.turnUpPct).toBe(50)
  })

  it("is null with no RSVPs rather than zero", async () => {
    const { eventId, occurrences } = await multiDay(1)
    await attend(eventId, occurrences[0].id, await person("t_walkin"))
    const a = await getEventAttendance(eventId)
    expect(a.turnUpPct).toBeNull()
  })

  it("caps at 100% when walk-ins outnumber RSVPs", async () => {
    // Three attended, one RSVP'd. 300% turn-up would render as nonsense.
    const { eventId, occurrences } = await multiDay(1)
    const rsvpd = await person("t_one")
    await db.event_rsvps.create({
      data: { event_id: eventId, user_id: rsvpd, status: "going" },
    })
    for (const l of ["w1", "w2", "w3"]) await attend(eventId, occurrences[0].id, await person(l))

    const a = await getEventAttendance(eventId)
    expect(a.turnUpPct).toBe(100)
  })
})
