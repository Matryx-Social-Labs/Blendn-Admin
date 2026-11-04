import { transformEvents } from "@/lib/services/events.service"

/*
 * Every list item carries `promoted`, `ticketed` and `fromPrice` (Flow 3b · N1, SCRUM-1022): the Pulse row says
 * "Promoted" in words and a price only when a ticket is on sale. One ticket query per page, none when nothing sells.
 */
jest.mock("@/lib/location", () => ({
  resolveEventCity: jest.fn(async (city: string | null) => city),
  geocodeBudget: () => ({ take: () => true, exhausted: false, spent: 0 }),
}))
jest.mock("@/lib/attendee-counts", () => ({ distinctAttendeeCounts: jest.fn(async () => new Map()), hereCounts: jest.fn(async () => new Map()) }))
jest.mock("@/lib/event-tallies", () => ({ eventTallies: jest.fn(async () => ({ favorites: new Map(), ratings: new Map(), going: new Map() })) }))
const mockFindMany = jest.fn()
jest.mock("@/lib/db", () => ({ db: { ticket_types: { findMany: (...a: unknown[]) => mockFindMany(...a) } } }))

const base = {
  slug: "e",
  title: "A night out",
  short_description: null,
  cover_image_url: null,
  start_time: new Date("2099-10-24T21:00:00.000Z"),
  end_time: new Date("2099-10-25T02:00:00.000Z"),
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
  ticket_fee_schedule: { currency: "INR" },
}

const previous = process.env.TICKETING
beforeEach(() => {
  process.env.TICKETING = "true"
  mockFindMany.mockReset()
})
afterAll(() => {
  process.env.TICKETING = previous
})

it("a native event says ticketed and its lowest on-sale price; an unticketed one says neither", async () => {
  mockFindMany.mockResolvedValue([{ event_id: "t", price_minor: 79900, quantity: 10, sold: 0, held: 0, hidden: false, sale_starts_at: null, sale_ends_at: null }])
  const [t, free] = await transformEvents([{ ...base, id: "t", ticketing_mode: "native" }, { ...base, id: "f", ticketing_mode: "off" }] as never, { favoriteEventIds: new Set<string>() })
  expect(t).toMatchObject({ promoted: false, ticketed: true, fromPrice: { minor: 79900, currency: "INR" } })
  expect(free).toMatchObject({ promoted: false, ticketed: false, fromPrice: null })
  // One query for the page, only for the event that sells natively, and never a hidden tier.
  expect(mockFindMany).toHaveBeenCalledTimes(1)
  expect(mockFindMany.mock.calls[0][0].where).toEqual({ event_id: { in: ["t"] }, hidden: false })
})

it("no query at all when nothing on the page sells natively", async () => {
  await transformEvents([{ ...base, id: "f", ticketing_mode: "off" }] as never, { favoriteEventIds: new Set<string>() })
  expect(mockFindMany).not.toHaveBeenCalled()
})
