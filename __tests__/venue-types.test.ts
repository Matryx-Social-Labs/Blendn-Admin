import {
  VENUE_TYPE_GROUPS,
  venueTypeLabel,
  defaultExtentMetres,
  venueTypeFromOsm,
} from "@/lib/venue-types"

/**
 * The venue vocabulary.
 *
 * Nothing distinguished a restaurant from a stadium before this, which is why
 * one check-in radius had to serve both. The default extent per type is the
 * quiet part: an organiser dropped on a map with one default for every venue
 * drags the handle until it "looks safe", and that is how a football match on
 * production ended up with a 100km radius.
 */

describe("the grouped vocabulary", () => {
  it("covers every value exactly once", () => {
    // A value in two groups renders twice in the picker; a value in none is
    // unreachable and will sit null forever.
    const all = VENUE_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.value))
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeGreaterThanOrEqual(30)
  })

  it("gives every value a human label, never the raw enum", () => {
    for (const group of VENUE_TYPE_GROUPS) {
      for (const type of group.types) {
        expect(type.label).not.toContain("_")
        expect(venueTypeLabel(type.value)).toBe(type.label)
      }
    }
  })

  it("names the unclassified case rather than rendering blank", () => {
    expect(venueTypeLabel(null)).toBe("Unclassified")
    expect(venueTypeLabel(undefined)).toBe("Unclassified")
  })

  it("keeps groups small enough to scan", () => {
    // The point of grouping is that no group is itself a scroll.
    for (const group of VENUE_TYPE_GROUPS) {
      expect(group.types.length).toBeLessThanOrEqual(6)
      expect(group.types.length).toBeGreaterThan(0)
    }
  })
})

describe("default extent scales with the venue", () => {
  it("gives a stadium far more room than a café", () => {
    // The whole reason venue_type exists. These are two orders of magnitude
    // apart in reality and had one shared default before.
    expect(defaultExtentMetres("stadium")).toBeGreaterThan(defaultExtentMetres("cafe") * 5)
  })

  it("is the building, not the check-in area", () => {
    // Buffer and the per-attendee GPS allowance both add on top, so these stay
    // conservative — and well under the 2000m server cap.
    for (const group of VENUE_TYPE_GROUPS) {
      for (const t of group.types) {
        const extent = defaultExtentMetres(t.value)
        expect(extent).toBeGreaterThan(0)
        expect(extent).toBeLessThanOrEqual(150)
      }
    }
  })

  it("falls back sensibly for an unclassified venue", () => {
    expect(defaultExtentMetres(null)).toBe(30)
    expect(defaultExtentMetres(undefined)).toBe(30)
  })

  it("gives open-air venues more room than indoor ones", () => {
    expect(defaultExtentMetres("park_ground")).toBeGreaterThan(defaultExtentMetres("restaurant"))
    expect(defaultExtentMetres("campus")).toBeGreaterThan(defaultExtentMetres("theatre"))
  })
})

describe("venueTypeFromOsm — suggest rather than ask", () => {
  it("reads the common amenity tags", () => {
    expect(venueTypeFromOsm({ amenity: "restaurant" })).toBe("restaurant")
    expect(venueTypeFromOsm({ amenity: "pub" })).toBe("pub_bar")
    expect(venueTypeFromOsm({ amenity: "bar" })).toBe("pub_bar")
    expect(venueTypeFromOsm({ amenity: "cafe" })).toBe("cafe")
    expect(venueTypeFromOsm({ amenity: "nightclub" })).toBe("nightclub")
  })

  it("reads leisure tags, including the stadium case", () => {
    // The venue that motivated all of this.
    expect(venueTypeFromOsm({ leisure: "stadium" })).toBe("stadium")
    expect(venueTypeFromOsm({ leisure: "sports_centre" })).toBe("sports_complex")
    expect(venueTypeFromOsm({ leisure: "park" })).toBe("park_ground")
  })

  it("maps a museum to a museum, not a gallery", () => {
    // Caught while writing these: tourism=museum returned art_gallery.
    expect(venueTypeFromOsm({ tourism: "museum" })).toBe("museum")
    expect(venueTypeFromOsm({ tourism: "gallery" })).toBe("art_gallery")
  })

  it("reads hotels and resorts", () => {
    expect(venueTypeFromOsm({ tourism: "hotel" })).toBe("hotel")
    expect(venueTypeFromOsm({ tourism: "resort" })).toBe("resort")
  })

  it("falls back to building tags when there is no amenity", () => {
    expect(venueTypeFromOsm({ building: "stadium" })).toBe("stadium")
    expect(venueTypeFromOsm({ building: "warehouse" })).toBe("warehouse")
  })

  it("prefers amenity over building when both are present", () => {
    // OSM tags a restaurant inside a retail building as both; the amenity is
    // what the place *is*.
    expect(venueTypeFromOsm({ amenity: "restaurant", building: "retail" })).toBe("restaurant")
  })

  it("returns null rather than guessing when nothing matches", () => {
    // A wrong suggestion the user does not notice is worse than no suggestion.
    expect(venueTypeFromOsm({})).toBeNull()
    expect(venueTypeFromOsm({ building: "yes" })).toBeNull()
    expect(venueTypeFromOsm({ amenity: "bicycle_parking" })).toBeNull()
  })

  it("only ever returns a value the picker can display", () => {
    const known = new Set(VENUE_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.value)))
    // Annotated, or the literal widens to a union where each member has
    // `undefined` for the keys it omits — which is not a Record<string,string>.
    const tagSets: Record<string, string>[] = [
      { amenity: "restaurant" }, { amenity: "pub" }, { amenity: "place_of_worship" },
      { leisure: "stadium" }, { leisure: "fitness_centre" }, { tourism: "hotel" },
      { tourism: "museum" }, { building: "warehouse" }, { shop: "supermarket" },
    ]
    for (const tags of tagSets) {
      const result = venueTypeFromOsm(tags)
      if (result !== null) expect(known.has(result)).toBe(true)
    }
  })
})
