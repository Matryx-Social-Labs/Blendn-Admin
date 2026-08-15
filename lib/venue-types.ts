import type { venue_type } from "@prisma/client"

/**
 * The venue type vocabulary, grouped for a picker.
 *
 * Thirty-five values in one flat select is a scroll, not a choice. The groups
 * are how a person actually narrows: they know they run a food place before
 * they know whether the right word is "pub" or "brewery".
 *
 * The enum order in `schema.prisma` matches these groups, so this file and the
 * database read the same way.
 */

export interface VenueTypeGroup {
  label: string
  types: { value: venue_type; label: string }[]
}

export const VENUE_TYPE_GROUPS: VenueTypeGroup[] = [
  {
    label: "Food & drink",
    types: [
      { value: "restaurant", label: "Restaurant" },
      { value: "pub_bar", label: "Pub or bar" },
      { value: "brewery", label: "Brewery" },
      { value: "cafe", label: "Café" },
      { value: "lounge_rooftop", label: "Lounge or rooftop" },
    ],
  },
  {
    label: "Nightlife",
    types: [
      { value: "nightclub", label: "Nightclub" },
      { value: "live_music_venue", label: "Live music venue" },
    ],
  },
  {
    label: "Events & hospitality",
    types: [
      { value: "banquet_hall", label: "Banquet hall" },
      { value: "convention_centre", label: "Convention or exhibition centre" },
      { value: "conference_centre", label: "Conference centre" },
      { value: "hotel", label: "Hotel" },
      { value: "resort", label: "Resort" },
      { value: "farmhouse", label: "Farmhouse" },
    ],
  },
  {
    label: "Sport",
    types: [
      { value: "stadium", label: "Stadium" },
      { value: "sports_complex", label: "Sports complex or ground" },
      { value: "gym_fitness_studio", label: "Gym or fitness studio" },
    ],
  },
  {
    label: "Culture",
    types: [
      { value: "theatre", label: "Theatre or auditorium" },
      { value: "cinema", label: "Cinema" },
      { value: "art_gallery", label: "Art gallery" },
      { value: "museum", label: "Museum" },
      { value: "amphitheatre", label: "Amphitheatre" },
    ],
  },
  {
    label: "Community",
    types: [
      { value: "community_hall", label: "Community hall" },
      { value: "coworking", label: "Co-working space" },
      { value: "campus", label: "University or college campus" },
      { value: "school", label: "School" },
      { value: "library", label: "Library" },
      { value: "religious_venue", label: "Temple, church or religious venue" },
    ],
  },
  {
    label: "Open air",
    types: [
      { value: "park_ground", label: "Park or open ground" },
      { value: "beach_waterfront", label: "Beach or waterfront" },
      { value: "terrace", label: "Terrace" },
    ],
  },
  {
    label: "Other",
    types: [
      { value: "studio", label: "Studio" },
      { value: "warehouse", label: "Warehouse or industrial space" },
      { value: "retail_mall", label: "Retail or mall space" },
      { value: "private_residence", label: "Private residence" },
      { value: "other", label: "Something else" },
    ],
  },
]

/**
 * Every value in the vocabulary, flat, for the callers that want a list rather
 * than a picker — the mobile `?venueType=` filter and its zod enum.
 *
 * Derived from the groups above rather than written out a second time. A
 * hand-maintained copy is a list that silently stops agreeing with the picker
 * the day someone adds a type to one and not the other, and the symptom is a
 * filter value the client can send and the server rejects.
 */
export const VENUE_TYPES = VENUE_TYPE_GROUPS.flatMap((g) =>
  g.types.map((t) => t.value)
) as [venue_type, ...venue_type[]]

const LABELS = new Map<venue_type, string>(
  VENUE_TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t.value, t.label] as const))
)

export function venueTypeLabel(type: venue_type | null | undefined): string {
  if (!type) return "Unclassified"
  return LABELS.get(type) ?? type
}

/**
 * A sensible starting extent, in metres, for a venue of this type.
 *
 * A café and a stadium are two orders of magnitude apart, and an organiser
 * dropped on a map with one default for both will drag the handle until it
 * "looks safe" — which is how a football match on production ended up with a
 * 100km radius. Starting close to right means most venues never touch it.
 *
 * Deliberately conservative: the buffer and the per-attendee GPS allowance both
 * add on top, so these are the *building*, not the check-in area.
 */
export function defaultExtentMetres(type: venue_type | null | undefined): number {
  switch (type) {
    case "stadium":
      return 150
    case "sports_complex":
    case "campus":
    case "park_ground":
    case "resort":
    case "beach_waterfront":
      return 120
    case "convention_centre":
    case "conference_centre":
    case "warehouse":
    case "retail_mall":
      return 80
    case "farmhouse":
    case "school":
    case "hotel":
    case "amphitheatre":
      return 60
    case "museum":
    case "theatre":
    case "cinema":
    case "banquet_hall":
    case "religious_venue":
    case "community_hall":
      return 40
    case "cafe":
    case "private_residence":
    case "studio":
    case "terrace":
      return 20
    default:
      // Restaurants, pubs, breweries, clubs, galleries, gyms, co-working.
      return 30
  }
}

/**
 * Map an OpenStreetMap tag to a venue type.
 *
 * When the building outline is imported from OSM, its tags usually say what the
 * place is — so the type can be suggested rather than asked for. A guess the
 * user corrects beats an empty required field.
 */
export function venueTypeFromOsm(tags: Record<string, string>): venue_type | null {
  const { amenity, leisure, building, tourism, shop } = tags

  const direct: Record<string, venue_type> = {
    restaurant: "restaurant",
    bar: "pub_bar",
    pub: "pub_bar",
    biergarten: "pub_bar",
    cafe: "cafe",
    nightclub: "nightclub",
    theatre: "theatre",
    cinema: "cinema",
    library: "library",
    school: "school",
    university: "campus",
    college: "campus",
    community_centre: "community_hall",
    place_of_worship: "religious_venue",
    coworking_space: "coworking",
    conference_centre: "conference_centre",
    exhibition_centre: "convention_centre",
  }
  if (amenity && direct[amenity]) return direct[amenity]

  if (leisure === "stadium") return "stadium"
  if (leisure === "sports_centre" || leisure === "pitch") return "sports_complex"
  if (leisure === "fitness_centre") return "gym_fitness_studio"
  if (leisure === "park" || leisure === "garden") return "park_ground"

  if (tourism === "hotel") return "hotel"
  if (tourism === "museum") return "museum"
  if (tourism === "gallery") return "art_gallery"
  if (tourism === "resort") return "resort"

  if (building === "stadium") return "stadium"
  if (building === "warehouse" || building === "industrial") return "warehouse"
  if (building === "retail" || shop) return "retail_mall"

  return null
}
