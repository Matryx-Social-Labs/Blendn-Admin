import { readFileSync } from "fs"
import { join } from "path"

/**
 * Amenities — the event layer.
 *
 * `docs/AMENITIES.md` planned a venue layer too. It is deliberately not built:
 * an **unowned** venue has no list to suggest from, and almost no venue is
 * owned today, so it would be a permission system and a picker that did
 * nothing. These tests pin the decisions that make the event layer safe to
 * ship on its own.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const SCHEMA = () => read("prisma", "schema.prisma")
const MIGRATION = () =>
  read("prisma", "migrations", "20260816020000_event_amenities", "migration.sql")

describe("retiring an amenity must not rewrite history", () => {
  it("uses Restrict on the amenity side, Cascade on the event side", () => {
    /*
     * Deleting an amenity that events reference would change what those events
     * said they offered — for events that already happened. `Restrict` refuses
     * the delete; `is_active = false` is how one is withdrawn.
     *
     * The event side is `Cascade` because deleting an *event* should take its
     * own claims with it.
     */
    const schema = SCHEMA()
    const model = schema.slice(schema.indexOf("model event_amenities"))
    const body = model.slice(0, model.indexOf("}"))
    expect(body).toContain("onDelete: Restrict")
    expect(body).toContain("onDelete: Cascade")

    const sql = MIGRATION()
    expect(sql).toContain('REFERENCES "amenities"("id")\n  ON DELETE RESTRICT')
    expect(sql).toContain('REFERENCES "events"("id")\n  ON DELETE CASCADE')
  })

  it("carries is_active, so withdrawal is possible at all", () => {
    /*
     * Without it, `Restrict` would make a mistaken amenity permanent.
     *
     * Matched on the fact, not the spacing. `prisma format` re-aligns a model's
     * columns whenever any field in it changes width, so an exact-string
     * assertion fails on an unrelated edit somewhere else in the same block --
     * which reads as a broken guard rather than a formatter.
     */
    expect(SCHEMA()).toMatch(/is_active\s+Boolean\s+@default\(true\)/)
  })

  it("hides retired amenities from every picker", () => {
    // Three places offer the vocabulary. All three filter; a retired amenity
    // already on an event still resolves, because the tick list comes from the
    // event's own rows.
    for (const f of [
      ["app", "api", "mobile", "amenities", "route.ts"],
      ["app", "dashboard", "events", "new", "page.tsx"],
      ["app", "dashboard", "events", "[id]", "edit", "page.tsx"],
    ]) {
      expect(read(...f)).toContain("is_active: true")
    }
  })
})

describe("ordering is explicit, not alphabetical", () => {
  it("sorts by sort_order everywhere the list is drawn", () => {
    /*
     * Alphabetical puts "Accessible Entrance" at the top of every picker and
     * every event card in the app. `sort_order` is the vocabulary's own
     * opinion, so two events with the same amenities list them the same way.
     */
    // Field and default, not column alignment — see the note above.
    // Whitespace-insensitive; see the is_active assertion above.
    expect(SCHEMA()).toMatch(/sort_order\s+Int\s+@default\(0\)/)
    for (const f of [
      ["app", "api", "mobile", "amenities", "route.ts"],
      ["app", "dashboard", "events", "new", "page.tsx"],
      ["app", "dashboard", "events", "[id]", "edit", "page.tsx"],
    ]) {
      expect(read(...f)).toContain('sort_order: "asc"')
    }
    // And on the event payload, through the join.
    expect(read("app", "api", "mobile", "events", "[eventId]", "route.ts")).toContain(
      'orderBy: { amenity: { sort_order: "asc" } }'
    )
  })
})

describe("the detail endpoint only — D11", () => {
  it("does not join amenities onto the event list", () => {
    /*
     * The cards on the Pulse draw no amenity, and `/events` is the hottest
     * endpoint in the product. A join there costs every list request for
     * something nothing renders.
     */
    const list = read("lib", "services", "events.service.ts")
    expect(list).not.toContain("amenities")
  })

  it("does join them onto the detail endpoint", () => {
    const detail = read("app", "api", "mobile", "events", "[eventId]", "route.ts")
    expect(detail).toContain("amenities: {")
    // Flattened: a client should not have to reach through `{ amenity: {...} }`
    // for every tile.
    expect(detail).toContain("event.amenities.map((a) => ({")
    expect(detail).toContain("name: a.amenity.name")
  })
})

describe("the organiser asserts; nothing is inherited or assumed", () => {
  it("ticks nothing by default", () => {
    /*
     * An event with no amenities draws no tiles, which is the honest state.
     * The alternative is every event claiming an open bar because a default
     * said so — and people turn up expecting these.
     */
    expect(read("components", "event-form.tsx")).toContain("amenity_ids: [],")
  })

  it("replaces the whole set rather than diffing it", () => {
    /*
     * The payload is the full list the organiser ticked, so a diff would have
     * to tell "unticked" from "not sent". An **absent key** already means "not
     * sent", which is what leaves an event's amenities alone.
     *
     * The anchor moved when the route dropped `?? undefined` for conditional
     * spreads (SCRUM-53): the shape is now
     * `...(Array.isArray(amenity_ids) ? { amenities: { deleteMany ... } } : {})`
     * rather than `amenities: Array.isArray(...) ? ... : undefined`. Same
     * behaviour, and the key is omitted rather than set to undefined — which
     * is the point of that change. Only the text this test greps for changed.
     */
    const update = read("app", "api", "events", "[id]", "route.ts")
    const start = update.indexOf("Array.isArray(amenity_ids)")
    // jest takes one argument; the message-as-second-arg is a Playwright idiom.
    expect({ found: start > -1 }).toEqual({ found: true })
    const block = update.slice(start, update.indexOf("media_items", start))
    expect(block).toContain("deleteMany: {}")
    // And still guarded, so a PATCH that does not mention amenities leaves
    // them alone rather than clearing them.
    expect(block).toContain("amenity_ids.map")
  })

  it("validates the ids as uuids before they reach a connect", () => {
    // A non-uuid would surface as a Prisma error rather than a 400 naming the
    // field.
    expect(read("lib", "validations", "event.ts")).toContain(
      "amenity_ids: z.array(z.string().uuid()).max(20).nullish()"
    )
  })

  it("does not read through to the venue at render time", () => {
    /*
     * The event stores its own rows. A venue editing its list next month
     * cannot change what last month's event claimed, and an organiser who
     * unticks something is believed.
     */
    const schema = SCHEMA()
    const model = schema.slice(schema.indexOf("model event_amenities"))
    expect(model.slice(0, model.indexOf("}"))).not.toContain("venue")
  })
})

describe("the venue layer is absent on purpose, not by omission", () => {
  it("ships no venue_amenities table", () => {
    // If this ever appears, `docs/AMENITIES.md`'s open question has been
    // answered — and `venuePermissions` has to land with it, or any venue
    // owner can edit any building's list.
    expect(SCHEMA()).not.toContain("model venue_amenities")
    expect(MIGRATION()).not.toContain("venue_amenities")
  })
})

describe("the migration is deployable", () => {
  it("seeds a starting vocabulary idempotently", () => {
    // Re-running a migration should not double the list, and a fresh database
    // and a migrated one should agree.
    const sql = MIGRATION()
    expect(sql).toContain('INSERT INTO "amenities"')
    expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING')
  })

  it("indexes the picker's query", () => {
    expect(MIGRATION()).toContain('"is_active", "sort_order"')
  })
})
