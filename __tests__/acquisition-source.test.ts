/**
 * SCRUM-1273: where a view, an RSVP and a sign-up came from (insights/02).
 *
 * The parser is the trust boundary for three routes, and it never refuses: an
 * unknown tag is no tag, so an analytics label can never cost somebody an RSVP
 * or a profile save, and a newer app keeps working against an older server.
 * The database CHECKs list the same values; the last test holds the two lists
 * together. The writes themselves are in integration/acquisition-source.itest.ts.
 */
const createMany = jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
jest.mock("@/lib/db", () => ({ db: { product_events: { createMany: (args: { data: unknown[] }) => createMany(args) } } }))

import { readdirSync, readFileSync } from "fs"
import { join } from "path"

import { ACQUISITION_SOURCES, PRODUCT_EVENTS, acquisitionSource, flushProductEvents, record, resetProductEventCache } from "@/lib/product-events"
import { profileForSelfResponse } from "@/lib/self-profile"

describe("acquisitionSource", () => {
  it.each(["door", "link", "invite", "web", "share"])("accepts %s", (tag) => {
    expect(acquisitionSource(tag)).toBe(tag)
  })

  it.each([["DOOR"], ["door "], [" door"], ["x"], [""], ["d".repeat(200)], ["door".repeat(50)], [null], [undefined], [1], [true], [["door"]], [{ source: "door" }]])(
    "reads %p as no source",
    (value) => {
      expect(acquisitionSource(value)).toBeNull()
    }
  )

  it("is the five sources, in the order the migrations list them", () => {
    expect(ACQUISITION_SOURCES).toEqual(["door", "link", "invite", "web", "share"])
  })
})

describe("record() carries the source into props", () => {
  beforeEach(() => {
    createMany.mockClear()
    resetProductEventCache()
  })
  afterAll(resetProductEventCache)

  const rows = () => createMany.mock.calls.flatMap(([args]) => args.data as Record<string, unknown>[])

  it("writes { source } when one is given", async () => {
    record({ name: PRODUCT_EVENTS.event_viewed, userId: "u1", entityKind: "event", entityId: "e1", props: { source: "door" } })
    await flushProductEvents()
    expect(rows()).toEqual([expect.objectContaining({ name: "event_viewed", props: { source: "door" } })])
  })

  it("writes no props key at all without one, as before", async () => {
    record({ name: PRODUCT_EVENTS.event_viewed, userId: "u1", entityKind: "event", entityId: "e1" })
    await flushProductEvents()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).not.toHaveProperty("props")
  })

  it("keeps the first source of the day: a second view with another tag is the same row", async () => {
    record({ name: PRODUCT_EVENTS.event_viewed, userId: "u1", entityKind: "event", entityId: "e1", props: { source: "door" } })
    record({ name: PRODUCT_EVENTS.event_viewed, userId: "u1", entityKind: "event", entityId: "e1", props: { source: "link" } })
    await flushProductEvents()
    expect(rows().map((r) => r.props)).toEqual([{ source: "door" }])
  })
})

describe("the person's own profile does not read back their sign-up source", () => {
  // Analytics, like `tier_b_changes`: the self response stays the shape installed builds already parse.
  it("drops signup_source", () => {
    const shaped = profileForSelfResponse({ name: "A", signup_source: "door", date_of_birth: null, age: null })
    expect(shaped).not.toHaveProperty("signup_source")
    expect(shaped).toMatchObject({ name: "A" })
  })
})

describe("the CHECK constraints list exactly ACQUISITION_SOURCES", () => {
  const DIR = join(process.cwd(), "prisma", "migrations")
  const sql = readdirSync(DIR)
    .filter((d) => /_(event_rsvps_source|profiles_signup_source)$/.test(d))
    .map((d) => readFileSync(join(DIR, d, "migration.sql"), "utf8"))

  it("has one migration per column", () => {
    expect(sql).toHaveLength(2)
  })

  it.each([0, 1])("migration %i names the same five values", (i) => {
    const list = /IN \(([^)]*)\)/.exec(sql[i] ?? "")?.[1] ?? ""
    expect(list.split(",").map((v) => v.trim().replace(/'/g, ""))).toEqual([...ACQUISITION_SOURCES])
  })
})
