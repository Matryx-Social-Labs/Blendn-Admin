const mockCreateVenue = jest.fn()
const mockToast = { success: jest.fn(), warning: jest.fn() }
jest.mock("@/lib/venue-actions", () => ({ createVenue: (...a: unknown[]) => mockCreateVenue(...a) }))
jest.mock("sonner", () => ({ toast: mockToast }))

import { saveAsVenue } from "@/components/event-form/save-as-venue"
import { Refusal } from "@/lib/refusal"
import type { EventFormValues } from "@/components/event-form/schema"

/*
 * SCRUM-353c: a place picked from the map is listed as a venue when its event
 * saves — unclaimed, with the area the event has — and a refusal is said, not
 * swallowed; the event saves either way.
 */
const circle = { type: "circle", lat: 12.9794, lng: 77.6406, radius: 30, buffer: 20 }
const values = (over: Partial<EventFormValues> = {}) =>
  ({
    venue_name: "Toit",
    venue_id: null,
    address: "298, 100 Feet Road",
    city: "Bengaluru",
    latitude: 12.9794,
    longitude: 77.6406,
    geofence: circle,
    new_venue: { venue_type: "pub_bar", acknowledged_duplicates: false },
    ...over,
  }) as EventFormValues

beforeEach(() => jest.clearAllMocks())

it("lists the place unclaimed, with the event's area, and returns its id", async () => {
  mockCreateVenue.mockResolvedValue({ id: "v1" })
  await expect(saveAsVenue(values())).resolves.toBe("v1")
  expect(mockCreateVenue).toHaveBeenCalledWith({
    name: "Toit",
    venueType: "pub_bar",
    address: "298, 100 Feet Road",
    city: "Bengaluru",
    lat: 12.9794,
    lng: 77.6406,
    geofence: circle,
    acknowledgedDuplicates: false,
    asUnclaimed: true,
  })
  expect(mockToast.success).toHaveBeenCalled()
})

it("carries the organiser's 'keep this as a different place'", async () => {
  mockCreateVenue.mockResolvedValue({ id: "v2" })
  await saveAsVenue(values({ new_venue: { venue_type: null, acknowledged_duplicates: true } }))
  expect(mockCreateVenue.mock.calls[0][0]).toMatchObject({ acknowledgedDuplicates: true, venueType: null })
})

it.each([
  ["no place was picked", { new_venue: null }],
  ["a listed venue is linked already", { venue_id: "listed" }],
  ["the name was cleared", { venue_name: "  " }],
  ["there is no pin", { latitude: undefined }],
])("lists nothing when %s", async (_why, over) => {
  await expect(saveAsVenue(values(over as Partial<EventFormValues>))).resolves.toBeNull()
  expect(mockCreateVenue).not.toHaveBeenCalled()
})

it("says the server's refusal and lets the event save", async () => {
  mockCreateVenue.mockRejectedValue(new Refusal("Toit is already listed 0 m away. Claim it instead, or confirm this is a different place."))
  await expect(saveAsVenue(values())).resolves.toBeNull()
  expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining("Toit is already listed 0 m away"))
})
