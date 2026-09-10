import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * Creating an event with the optional fields left blank, against real Postgres.
 *
 * `POST /api/events` built `prisma.events.create()` with bare shorthand for
 * eleven optional fields. A form that leaves them blank sends `undefined`, and
 * under `strictUndefinedChecks` that is a runtime error — so **every event
 * creation on staging returned 500**. Only `title`, `description`,
 * `start_time`, `end_time` and `timezone` are required; everything else is
 * exactly the set an organiser routinely omits.
 *
 * **The conversion was already there and was only half done.** Five fields had
 * conditional spreads — `door_policy`, `is_featured`, `is_recurring`,
 * `check_in_radius`, `geofence` — under a comment explaining precisely why the
 * idiom is necessary. The other eleven kept the shorthand, and the comment gave
 * the next reader no reason to look. A partial conversion that documents itself
 * as complete is worse than none.
 *
 * Fourth instance of this class to reach staging, after
 * `mobile_refresh_tokens.device_info`, the `profiles` upsert, and signup. The
 * general guard is SCRUM-60, and four outages is the argument for it.
 *
 * Invisible to `tsc` (every one of these columns is optional) and to the unit
 * suite (which mocks `@/lib/db`), so it can only be caught here.
 */
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.event_details.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

/**
 * The route's own write, with every optional field threaded through as the
 * handler threads it.
 *
 * Taking them as parameters and spreading is the point: passing `undefined`
 * explicitly is what the broken code did, and a test that simply omitted the
 * keys would have passed against it.
 */
async function createEvent(
  organizerId: string,
  opts: {
    short_description?: string
    venue_name?: string
    max_capacity?: number
    cover_image_url?: string
    external_link?: string
    house_rules?: string
    covid_guidelines?: string
  }
) {
  return db.events.create({
    data: {
      title: "Sagar Kishore Test Night",
      slug: testId("evt-slug"),
      description: "An event created with the optional fields left blank.",
      ...(opts.short_description !== undefined && { short_description: opts.short_description }),
      ...(opts.venue_name !== undefined && { venue_name: opts.venue_name }),
      ...(opts.max_capacity !== undefined && { max_capacity: opts.max_capacity }),
      ...(opts.cover_image_url !== undefined && { cover_image_url: opts.cover_image_url }),
      ...(opts.external_link !== undefined && { external_link: opts.external_link }),
      start_time: new Date("2026-09-13T13:30:00.000Z"),
      end_time: new Date("2026-09-13T17:30:00.000Z"),
      timezone: "Asia/Kolkata",
      status: "draft",
      visibility: "public",
      organizer_id: organizerId,
      details: {
        create: {
          full_description: "Driven in a browser, asserted in Postgres.",
          ...(opts.house_rules !== undefined && { house_rules: opts.house_rules }),
          ...(opts.covid_guidelines !== undefined && { covid_guidelines: opts.covid_guidelines }),
        },
      },
    },
  })
}

describe("creating an event", () => {
  it("saves when every optional field is omitted", async () => {
    const organizerId = await makeUser(testId("evt-org"), "organizer")
    users.push(organizerId)

    const event = await createEvent(organizerId, {})
    events.push(event.id)

    expect(event.short_description).toBeNull()
    expect(event.venue_name).toBeNull()
    expect(event.max_capacity).toBeNull()
    expect(event.cover_image_url).toBeNull()
    expect(event.external_link).toBeNull()
    expect(event.status).toBe("draft")
  })

  it("saves when the optional fields are supplied", async () => {
    const organizerId = await makeUser(testId("evt-org2"), "organizer")
    users.push(organizerId)

    const event = await createEvent(organizerId, {
      short_description: "One line",
      venue_name: "Church Street Social",
      max_capacity: 120,
      house_rules: "Be kind",
    })
    events.push(event.id)

    expect(event.short_description).toBe("One line")
    expect(event.venue_name).toBe("Church Street Social")
    expect(event.max_capacity).toBe(120)
  })

  it("edits an event whose optional details are blank", async () => {
    /*
     * The `upsert` variant, and the one that broke editing.
     *
     * `PATCH /api/events/[id]` sends `details: { upsert: { create, update } }`.
     * The `update` branch was correct and narrow; the `create` branch passed
     * `house_rules`, `cancellation_policy` and `covid_guidelines` bare. **Prisma
     * validates both branches before running either**, so every edit of an
     * event that already had a details row failed on a branch that would never
     * have executed — the same lesson `profiles` learned in #329, in a second
     * file.
     *
     * The event is created first *with* a details row, so the update branch is
     * the one that would run. If the guard ever stops covering the create
     * branch, this is the case that notices.
     */
    const organizerId = await makeUser(testId("evt-org4"), "organizer")
    users.push(organizerId)

    const event = await createEvent(organizerId, {})
    events.push(event.id)

    const blank: { house_rules?: string; cancellation_policy?: string; covid_guidelines?: string } = {}

    await expect(
      db.events.update({
        where: { id: event.id },
        data: {
          title: "Sagar Kishore Test Night",
          details: {
            upsert: {
              create: {
                full_description: "Edited.",
                ...(blank.house_rules !== undefined && { house_rules: blank.house_rules }),
                ...(blank.cancellation_policy !== undefined && {
                  cancellation_policy: blank.cancellation_policy,
                }),
                ...(blank.covid_guidelines !== undefined && { covid_guidelines: blank.covid_guidelines }),
              },
              update: { full_description: "Edited." },
            },
          },
        },
      })
    ).resolves.toBeTruthy()

    const details = await db.event_details.findFirst({ where: { event_id: event.id } })
    expect(details?.full_description).toBe("Edited.")
  })

  it("writes the nested details row either way", async () => {
    /*
     * `details` is a nested create, and the six fields inside it were undefined
     * too. Prisma validates the nested write as part of the same invocation, so
     * a blank house-rules field failed the whole event — the same shape as the
     * `upsert` lesson: an invalid branch fails a write that never needed it.
     */
    const organizerId = await makeUser(testId("evt-org3"), "organizer")
    users.push(organizerId)

    const event = await createEvent(organizerId, {})
    events.push(event.id)

    const details = await db.event_details.findFirst({ where: { event_id: event.id } })
    expect(details).not.toBeNull()
    expect(details?.house_rules).toBeNull()
  })
})
