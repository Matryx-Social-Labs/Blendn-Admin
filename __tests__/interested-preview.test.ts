import { transformEvents } from "@/lib/services/events.service"

jest.mock("@/lib/location", () => ({
  resolveEventCity: jest.fn(async (city: string | null) => city),
}))

// `transformEvent` is private now — the plural owns the attendee query, so a
// caller cannot build a list without answering "how many people" first.
jest.mock("@/lib/attendee-counts", () => ({
  distinctAttendeeCounts: jest.fn(async () => new Map([["e1", 4]])),
}))

const transformOne = async (event: unknown, ctx: Parameters<typeof transformEvents>[1]) =>
  (await transformEvents([event] as never, ctx))[0]

/*
 * The interested list stops handing out faces.
 *
 * `interestedPreview` returned `user.image` — real photographs — for everyone
 * who had favourited an event, to **any authenticated caller** who added
 * `include=interestedPreview`, with no identity gate of any kind. The app was
 * rendering them: `EventDetailScreen` drew an avatar row from the payload.
 *
 * This is the same class as the roster leak, and worse in one respect. The
 * roster at least has a check-in, a pseudonym and a reveal — three things
 * somebody passes through knowingly. Favouriting has none: it is a private act,
 * and nobody who used it consented to being shown to strangers.
 *
 * It was also harvestable by topic. Favourite an event, ask for the preview,
 * collect the faces of everybody else interested in that category — and a
 * category plus a face is an inference about a person, not a picture of one.
 *
 * `favoriteCount` is the social proof the feature actually needed, and it was
 * on the payload the whole time.
 */

const EVENT = {
  id: "e1",
  slug: "e1",
  title: "A night out",
  short_description: null,
  cover_image_url: null,
  start_time: new Date("2026-10-24T21:00:00.000Z"),
  end_time: new Date("2026-10-25T02:00:00.000Z"),
  timezone: "Asia/Kolkata",
  venue_name: "The Humming Tree",
  address: null,
  city: "Bengaluru",
  state: null,
  country: null,
  latitude: 12.97,
  longitude: 77.59,
  status: "published",
  is_featured: false,
  organizer: null,
  categories: [],
  media: [],
  _count: { favorites: 124, ratings: 0 },
} as never

describe("GET /events never previews who is interested", () => {
  it("returns no photographs of interested users", async () => {
    const out = await transformOne(EVENT, { favoriteEventIds: new Set<string>() })
    expect(out).not.toHaveProperty("interestedPreview")
  })

  it("cannot be re-enabled by an include flag", async () => {
    /*
     * The context key is gone as well as the field, so a caller reaching for
     * the old switch gets nothing rather than a rebuilt leak. Cast because the
     * property no longer exists on the type — which is the point.
     */
    const out = await transformOne(EVENT, {
      favoriteEventIds: new Set<string>(),
      includeInterestedPreview: true,
      interestedPreviewMap: { e1: ["https://cdn.example/real-face.jpg"] },
    } as never)
    expect(JSON.stringify(out)).not.toContain("real-face")
    expect(out).not.toHaveProperty("interestedPreview")
  })

  it("still carries the count, which is what the design needed", async () => {
    // "124 interested" is the social proof. The faces were never the point.
    const out = await transformOne(EVENT, { favoriteEventIds: new Set<string>() })
    expect(out.favoriteCount).toBe(124)
  })

  it("leaks nothing else shaped like a person", async () => {
    // A blunt sweep, because the failure mode is a field nobody remembered.
    const body = JSON.stringify(
      await transformOne(EVENT, { favoriteEventIds: new Set<string>() })
    )
    for (const key of ["interestedPreview", "attendees", "favoritedBy", "checkedInUsers"]) {
      expect(body).not.toContain(key)
    }
  })
})
