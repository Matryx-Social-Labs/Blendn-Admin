const mockDb = { events: { findMany: jest.fn() } }
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { uniqueEventSlug } from "@/lib/event-slug"

/**
 * `events.slug` is `@unique`, and both write paths wrote `slugify(title)` into
 * it unconditionally. A promoter running "Summer Sessions" every month got an
 * unhandled Prisma P2002 on the second one — surfaced to them as "Internal
 * error", with the draft lost.
 *
 * The suffix is asserted here rather than at the route, because the route only
 * ever sees the string this returns.
 */

/** The slugs Postgres already holds under the queried prefix. */
const held = (...slugs: string[]) =>
  mockDb.events.findMany.mockResolvedValue(slugs.map((slug) => ({ slug })))

const whereArg = () => mockDb.events.findMany.mock.calls[0][0].where

beforeEach(() => {
  jest.clearAllMocks()
  held()
})

describe("uniqueEventSlug", () => {
  it("uses the plain slug when nothing holds it", async () => {
    expect(await uniqueEventSlug("Summer Sessions")).toBe("summer-sessions")
  })

  it("suffixes the second event with the same title", async () => {
    // The reported defect: this call used to be `slugify(title)` and the write
    // that followed it was a P2002.
    held("summer-sessions")
    expect(await uniqueEventSlug("Summer Sessions")).toBe("summer-sessions-2")
  })

  it("keeps counting when the suffix is taken too", async () => {
    held("summer-sessions", "summer-sessions-2", "summer-sessions-3")
    expect(await uniqueEventSlug("Summer Sessions")).toBe("summer-sessions-4")
  })

  it("ignores a longer slug that merely starts the same way", async () => {
    // The prefix query is deliberately loose; "summer-sessions-finale" is a
    // different event and must not push the counter along.
    held("summer-sessions-finale")
    expect(await uniqueEventSlug("Summer Sessions")).toBe("summer-sessions")
  })

  it("lets an event keep its own slug when the title is saved again", async () => {
    // Renaming an event to what it is already called must not collide with
    // itself and drift to -2 on every save.
    await uniqueEventSlug("Summer Sessions", "evt-1")
    expect(whereArg().id).toEqual({ not: "evt-1" })
  })

  it("does not exclude itself when there is no event yet", async () => {
    await uniqueEventSlug("Summer Sessions")
    expect(whereArg().id).toBeUndefined()
  })

  it("counts slugs held by soft-deleted events", async () => {
    // `deleted_at` does not release a unique constraint. Filtering deleted rows
    // out here would hand back a slug the database still refuses.
    await uniqueEventSlug("Summer Sessions")
    expect(whereArg().deleted_at).toBeUndefined()
  })

  it("falls back to a readable base when the title slugifies to nothing", async () => {
    // An all-emoji title is legal — `title` is only length-bounded — and an
    // empty slug is a URL that resolves to the index, not to the event.
    expect(await uniqueEventSlug("🎉🎉🎉")).toBe("event")
  })
})
