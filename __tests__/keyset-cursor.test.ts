import { createdBefore, decodeKeyset, encodeKeyset, keysetPage, LEGACY_PAGE, parseListQuery } from "@/lib/pagination"

describe("keyset cursors", () => {
  const at = new Date("2026-10-22T10:00:00.000Z")

  it("round-trips a time and an id, with and without the second time", () => {
    expect(decodeKeyset(encodeKeyset(at, "abc"))).toEqual({ at, id: "abc" })
    expect(decodeKeyset(encodeKeyset(null, "abc", at))).toEqual({ at: null, id: "abc", createdAt: at })
    expect(decodeKeyset(encodeKeyset(at, "abc", at))).toEqual({ at, id: "abc", createdAt: at })
  })

  it.each([
    ["not base64 json", "!!!"],
    ["json that is not ours", Buffer.from('"x"').toString("base64url")],
    ["no id", Buffer.from(JSON.stringify({ t: null })).toString("base64url")],
    ["an id that is not a string", Buffer.from(JSON.stringify({ t: null, id: 5 })).toString("base64url")],
    ["a huge id", Buffer.from(JSON.stringify({ t: null, id: "x".repeat(200) })).toString("base64url")],
    ["a time that is not a date", Buffer.from(JSON.stringify({ t: "yesterday", id: "a" })).toString("base64url")],
    ["a second time that is not a date", Buffer.from(JSON.stringify({ t: null, id: "a", c: "soon" })).toString("base64url")],
    ["a null second time", Buffer.from(JSON.stringify({ t: null, id: "a", c: null })).toString("base64url")],
  ])("refuses %s", (_name, raw) => {
    expect(decodeKeyset(raw)).toBeNull()
  })

  it("pages: one row past the limit says there is more and where to resume", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `r${n}`, at: new Date(at.getTime() - n * 1000) }))
    const page = keysetPage(rows, 2, (r) => ({ at: r.at, id: r.id }))
    expect(page.items.map((r) => r.id)).toEqual(["r1", "r2"])
    expect(page.hasMore).toBe(true)
    expect(decodeKeyset(page.nextCursor!)).toEqual({ at: rows[1].at, id: "r2" })

    const last = keysetPage(rows.slice(0, 2), 2, (r) => ({ at: r.at, id: r.id }))
    expect(last).toMatchObject({ hasMore: false, nextCursor: null })
    expect(keysetPage([], 2, () => ({ at: at, id: "x" }))).toEqual({ items: [], hasMore: false, nextCursor: null })
  })

  it("continues a created_at DESC, id DESC order: older, or the same instant and a smaller id", () => {
    expect(createdBefore({ at, id: "m" })).toEqual({ OR: [{ created_at: { lt: at } }, { created_at: at, id: { lt: "m" } }] })
  })

  it("reads limit and cursor from a query string, held to 1-100", () => {
    expect(parseListQuery(new URLSearchParams("limit=1000"), 50)).toMatchObject({ limit: 100 })
    expect(parseListQuery(new URLSearchParams("limit=0"), 50)).toMatchObject({ limit: 1 })
    expect(parseListQuery(new URLSearchParams("limit=abc"), 50)).toMatchObject({ limit: 50 })
    expect(parseListQuery(new URLSearchParams(), 50)).toEqual({ limit: 50, after: null })
    expect(parseListQuery(new URLSearchParams(`cursor=${encodeKeyset(at, "a")}`), 50)).toEqual({ limit: 50, after: { at, id: "a" } })
    expect(parseListQuery(new URLSearchParams("cursor=garbage"), 50)).toBe("bad_cursor")
  })

  describe("the legacy page: a build that cannot page", () => {
    it("with neither limit nor cursor is answered up to the legacy limit, before the 1-100 clamp", () => {
      expect(parseListQuery(new URLSearchParams(), 50, LEGACY_PAGE)).toEqual({ limit: 200, after: null })
      expect(LEGACY_PAGE).toBe(200)
    })
    it("a limit means a client that pages: held to 1-100", () => {
      expect(parseListQuery(new URLSearchParams("limit=1000"), 50, LEGACY_PAGE)).toMatchObject({ limit: 100 })
      expect(parseListQuery(new URLSearchParams("limit=0"), 50, LEGACY_PAGE)).toMatchObject({ limit: 1 })
      expect(parseListQuery(new URLSearchParams("limit=abc"), 50, LEGACY_PAGE)).toMatchObject({ limit: 50 })
      expect(parseListQuery(new URLSearchParams("limit=20"), 50, LEGACY_PAGE)).toMatchObject({ limit: 20 })
    })
    it("a cursor with no limit is a client that pages: the default, never 200", () => {
      expect(parseListQuery(new URLSearchParams(`cursor=${encodeKeyset(at, "a")}`), 50, LEGACY_PAGE)).toEqual({ limit: 50, after: { at, id: "a" } })
      expect(parseListQuery(new URLSearchParams("cursor=garbage"), 50, LEGACY_PAGE)).toBe("bad_cursor")
    })
    it("a route with no legacy limit is unchanged", () => {
      expect(parseListQuery(new URLSearchParams(), 100)).toEqual({ limit: 100, after: null })
    })
  })
})
