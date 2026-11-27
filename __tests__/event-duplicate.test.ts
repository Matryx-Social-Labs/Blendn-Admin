/**
 * SCRUM-1153: "Duplicate" on an event prefills the New event form with next
 * week's night. The mapper is an allow-list: only named fields pass, dates
 * move by whole calendar weeks on the event's own clock (so 21:00 stays 21:00
 * across a DST change), and nothing about guests, money or the room comes
 * along. Real `Intl` and `date-fns-tz`; the clock is the `now` argument.
 */
import { duplicatePrefill, duplicateSourceSelect, type DuplicateSource } from "@/lib/event-duplicate"

const TORONTO = "America/Toronto"

function source(overrides: Partial<DuplicateSource> = {}): DuplicateSource {
  return {
    title: "Thursday Supper Club",
    description: "Long-table dinner",
    short_description: "Natural wine, guest chef",
    venue_name: "The Drake Underground",
    venue_id: "11111111-1111-4111-8111-111111111111",
    address: "1150 Queen St W",
    city: "Toronto",
    state: "ON",
    country: "Canada",
    postal_code: "M6J 1J3",
    start_time: new Date("2027-03-14T02:00:00Z"), // Sat 13 Mar 21:00 EST
    end_time: new Date("2027-03-14T06:00:00Z"), // Sun 14 Mar 01:00 EST
    timezone: TORONTO,
    visibility: "public",
    max_capacity: 80,
    min_age: 19,
    door_policy: "guest_list",
    latitude: 43.6435,
    longitude: -79.4239,
    cover_image_url: "https://media.example/events/u1/cover.jpg",
    crews_enabled: false,
    check_in_radius: 45,
    geofence: { type: "circle", radius: 40, buffer: 20 },
    details: {
      full_description: "The long version",
      house_rules: "Be kind",
      cancellation_policy: "None",
      additional_info: { Parking: "Street" },
      faq: [{ question: "Vegan?", answer: "Yes" }],
      accessibility_info: { Ramp: "Yes" },
    },
    categories: [
      { primary: false, category: { id: "c-2" } },
      { primary: true, category: { id: "c-1" } },
    ],
    amenities: [{ amenity_id: "a-1" }],
    media: [
      {
        type: "image",
        url: "https://media.example/events/u1/a.jpg",
        thumbnail_url: null,
        title: null,
        description: null,
        order: 0,
        width: 1600,
        height: 1600,
        duration_ms: null,
        focal_x: 0.5,
        focal_y: 0.4,
        renditions: null,
      },
    ],
    ...overrides,
  }
}

const wall = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).format(new Date(iso))

describe("duplicatePrefill dates", () => {
  it("keeps 21:00 at 21:00 across Toronto's March change, end after midnight included", () => {
    // Sat 13 Mar 2027 21:00 EST → Sun 01:00 EST. DST starts Sun 14 Mar 02:00.
    const out = duplicatePrefill(source(), new Date("2027-03-01T12:00:00Z"))

    expect(out.initialEvent.start_time).toBe("2027-03-21T01:00:00.000Z") // Sat 20 Mar 21:00 EDT
    expect(out.initialEvent.end_time).toBe("2027-03-21T05:00:00.000Z") // Sun 21 Mar 01:00 EDT
    expect(wall(out.initialEvent.start_time, TORONTO)).toBe(wall("2027-03-14T02:00:00Z", TORONTO).replace("03-13", "03-20"))
    expect(out.weeks).toBe(1)
  })

  it("keeps 21:00 at 21:00 across Toronto's November change", () => {
    // Sat 6 Nov 2027 21:00 EDT → Sun 7 Nov 01:30 EDT. DST ends Sun 7 Nov 02:00.
    const out = duplicatePrefill(
      source({ start_time: new Date("2027-11-07T01:00:00Z"), end_time: new Date("2027-11-07T05:30:00Z") }),
      new Date("2027-11-01T12:00:00Z")
    )

    expect(out.initialEvent.start_time).toBe("2027-11-14T02:00:00.000Z") // Sat 13 Nov 21:00 EST
    expect(out.initialEvent.end_time).toBe("2027-11-14T06:30:00.000Z") // Sun 14 Nov 01:30 EST
  })

  it("moves an event with no DST by exactly seven days", () => {
    const out = duplicatePrefill(
      source({ timezone: "Asia/Kolkata", start_time: new Date("2026-12-03T15:00:00Z"), end_time: new Date("2026-12-03T21:00:00Z") }),
      new Date("2026-11-26T00:00:00Z")
    )

    expect(out.initialEvent.start_time).toBe("2026-12-10T15:00:00.000Z")
    expect(out.initialEvent.end_time).toBe("2026-12-10T21:00:00.000Z")
    expect(out.weeks).toBe(1)
  })

  it("moves a past event on by whole weeks to the next one ahead, same weekday and time", () => {
    // Thu 5 Nov 2026 19:30 Toronto (EST), opened Fri 27 Nov: Thu 3 Dec is 4 weeks on.
    const out = duplicatePrefill(
      source({ start_time: new Date("2026-11-06T00:30:00Z"), end_time: new Date("2026-11-06T04:30:00Z") }),
      new Date("2026-11-27T15:00:00Z")
    )

    expect(out.weeks).toBe(4)
    expect(out.initialEvent.start_time).toBe("2026-12-04T00:30:00.000Z")
    expect(new Date(out.initialEvent.start_time).getTime()).toBeGreaterThan(Date.parse("2026-11-27T15:00:00Z"))
  })

  it("skips a week whose start is exactly now: the copy is always in the future", () => {
    const start = new Date("2026-11-19T15:00:00Z")
    const out = duplicatePrefill(
      source({ timezone: "Asia/Kolkata", start_time: start, end_time: new Date("2026-11-19T18:00:00Z") }),
      new Date("2026-11-26T15:00:00Z")
    )

    expect(out.weeks).toBe(2)
    expect(out.initialEvent.start_time).toBe("2026-12-03T15:00:00.000Z")
  })
})

describe("duplicatePrefill note", () => {
  it("names the source by its date, one week on", () => {
    const out = duplicatePrefill(
      source({ start_time: new Date("2026-12-04T00:30:00Z"), end_time: new Date("2026-12-04T04:30:00Z") }),
      new Date("2026-11-27T15:00:00Z")
    )

    expect(out.note.lead).toBe("A copy of your Thu 3 Dec event, moved one week later to Thu 10 Dec, 19:30.")
    expect(out.note.rest).toBe(
      "Nothing is saved until you publish or save a draft. Guests, the room, announcements, sponsors and tickets stay with the original, and this is a single event, not a series."
    )
  })

  it("says how many weeks, and why, when the source is in the past", () => {
    const out = duplicatePrefill(
      source({ start_time: new Date("2026-11-06T00:30:00Z"), end_time: new Date("2026-11-06T04:30:00Z") }),
      new Date("2026-11-27T15:00:00Z")
    )

    expect(out.note.lead).toBe(
      "A copy of your Thu 5 Nov event, moved 4 weeks later to the next Thursday ahead: Thu 3 Dec, 19:30."
    )
  })

  it("adds the year only when the two dates fall in different years", () => {
    const out = duplicatePrefill(
      source({ timezone: "Asia/Kolkata", start_time: new Date("2026-12-26T15:00:00Z"), end_time: new Date("2026-12-26T18:00:00Z") }),
      new Date("2026-12-20T00:00:00Z")
    )

    expect(out.note.lead).toBe("A copy of your Sat 26 Dec 2026 event, moved one week later to Sat 2 Jan 2027, 20:30.")
  })
})

describe("duplicatePrefill allow-list", () => {
  const EXPECTED_KEYS = [
    "title", "description", "full_description", "short_description",
    "venue_name", "venue_id", "address", "city", "state", "country", "postal_code",
    "start_time", "end_time", "timezone", "status", "visibility",
    "max_capacity", "min_age", "door_policy", "latitude", "longitude",
    "cover_image_url", "crews_enabled", "check_in_radius", "geofence",
    "category_ids", "amenity_ids", "primary_category_id",
    "house_rules", "cancellation_policy", "additional_info", "faq", "accessibility_info",
    "media_items",
  ].sort()

  it("passes exactly the named fields, as a draft with no id", () => {
    const out = duplicatePrefill(source(), new Date("2027-03-01T12:00:00Z"))

    expect(Object.keys(out.initialEvent).sort()).toEqual(EXPECTED_KEYS)
    expect(out.initialEvent.status).toBe("draft")
    expect("id" in out.initialEvent).toBe(false)
  })

  it("copies what a weekly night re-enters: venue, area, who can come, media, More", () => {
    const out = duplicatePrefill(source(), new Date("2027-03-01T12:00:00Z")).initialEvent

    expect(out).toMatchObject({
      title: "Thursday Supper Club",
      venue_id: "11111111-1111-4111-8111-111111111111",
      geofence: { type: "circle", radius: 40, buffer: 20 },
      check_in_radius: 45,
      min_age: 19,
      door_policy: "guest_list",
      crews_enabled: false,
      category_ids: ["c-2", "c-1"],
      primary_category_id: "c-1",
      amenity_ids: ["a-1"],
      house_rules: "Be kind",
      faq: [{ question: "Vegan?", answer: "Yes" }],
      cover_image_url: "https://media.example/events/u1/cover.jpg",
    })
    expect(out.media_items).toEqual([expect.objectContaining({ url: "https://media.example/events/u1/a.jpg", focal_y: 0.4 })])
  })

  it("never copies a field it does not name, including a column added to events later", () => {
    const row = {
      ...source(),
      id: "src-id",
      slug: "thursday-supper-club",
      status: "published",
      organizer_id: "creator",
      organizer_org_id: "org-a",
      external_link: "https://tickets.example/thursday",
      ticketing_mode: "native",
      external_ticket_url: "https://tickets.example/x",
      ticket_fee_schedule: { slabs: [] },
      review_demo: true,
      curated_at: new Date(),
      claimed_at: new Date(),
      is_featured: true,
      is_recurring: true,
      current_capacity: 54,
      venue_link_status: "confirmed",
      brand_new_column: "LEAK-SENTINEL",
    } as unknown as DuplicateSource

    const out = duplicatePrefill(row, new Date("2027-03-01T12:00:00Z"))
    const text = JSON.stringify(out)

    for (const leaked of [
      "src-id", "thursday-supper-club", "creator", "org-a", "tickets.example",
      "native", "LEAK-SENTINEL", "brand_new_column", "review_demo", "curated_at",
      "is_featured", "is_recurring", "current_capacity", "venue_link_status",
    ]) {
      expect(text).not.toContain(leaked)
    }
    expect(Object.keys(out.initialEvent).sort()).toEqual(EXPECTED_KEYS)
  })
})

describe("duplicateSourceSelect", () => {
  it("reads only the named columns: no include, no ids, nothing about money, curation or the room", () => {
    expect(Object.keys(duplicateSourceSelect).sort()).toEqual(
      [
        "title", "description", "short_description", "venue_name", "venue_id", "address", "city", "state", "country",
        "postal_code", "start_time", "end_time", "timezone", "visibility", "max_capacity", "min_age", "door_policy",
        "latitude", "longitude", "cover_image_url", "crews_enabled", "check_in_radius", "geofence",
        "details", "categories", "amenities", "media",
      ].sort()
    )
    // The media rows are spread into the prefill, so their select is the allow-list: no id, no event_id.
    expect(Object.keys(duplicateSourceSelect.media.select).sort()).toEqual(
      ["type", "url", "thumbnail_url", "title", "description", "order", "width", "height", "duration_ms", "focal_x", "focal_y", "renditions"].sort()
    )
  })
})
