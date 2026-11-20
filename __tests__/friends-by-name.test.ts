import { byName, letterOf, parseFrom, sortByName } from "@/lib/friends-by-name"

const row = (name: string, userId = name) => ({ userId, name })

describe("letterOf (the client's lib/friendsIndex.ts rule, byte for byte)", () => {
  it.each([
    ["Aarav", "A"],
    ["ábhi", "A"],
    ["  zoe", "Z"],
    ["Élodie", "E"],
    ["प्रियंका शर्मा", "प"],
    ["Олег", "О"],
    ["7even", "#"],
    ["🎉 Party", "#"],
    ["", "#"],
  ])("%s files under %s", (name, head) => {
    expect(letterOf(name)).toBe(head)
  })
})

describe("sortByName", () => {
  const names = ["Zoe", "7even", "प्रियंका", "ábhi", "Олег", "Marc-André", "Aarav", "Élodie"]

  it("puts Latin A–Z first, then other scripts, then #, names in order inside a letter", () => {
    expect(sortByName(names.map((n) => row(n))).map((r) => r.name)).toEqual([
      "Aarav",
      "ábhi",
      "Élodie",
      "Marc-André",
      "Zoe",
      "Олег",
      "प्रियंका",
      "7even",
    ])
  })

  it("breaks a tie on the same name by id, so the order is total", () => {
    const sorted = sortByName([row("Anna", "b"), row("anna", "a"), row("Anna", "c")])
    expect(sorted.map((r) => r.userId)).toEqual(["a", "b", "c"])
  })
})

describe("byName (pages, letters, from)", () => {
  const rows = ["Zoe", "7even", "प्रियंका", "ábhi", "Олег", "Marc-André", "Aarav", "Élodie"].map((n, i) => row(n, `u${i}`))

  it("counts every letter in display order", () => {
    expect((byName(rows, { limit: 100 }) as { letters: unknown }).letters).toEqual([
      { letter: "A", count: 2 },
      { letter: "E", count: 1 },
      { letter: "M", count: 1 },
      { letter: "Z", count: 1 },
      { letter: "О", count: 1 },
      { letter: "प", count: 1 },
      { letter: "#", count: 1 },
    ])
  })

  it("walks every row once by cursor, never repeating or skipping", () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const page = byName(rows, { limit: 3, cursor })
      if (page === "bad_cursor") throw new Error("bad cursor")
      seen.push(...page.items.map((r) => r.name))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(sortByName(rows).map((r) => r.name))
  })

  it("keeps its place when a friend is added before the cursor", () => {
    const first = byName(rows, { limit: 2 })
    if (first === "bad_cursor") throw new Error()
    const next = byName([...rows, row("Aaron", "u99")], { limit: 2, cursor: first.nextCursor! })
    if (next === "bad_cursor") throw new Error()
    expect(next.items.map((r) => r.name)).toEqual(["Élodie", "Marc-André"])
  })

  it("starts at a letter with from, and at the next letter that has names when it has none", () => {
    const at = (from: string) => {
      const page = byName(rows, { limit: 2, from })
      if (page === "bad_cursor") throw new Error()
      return page.items.map((r) => r.name)
    }
    expect(at("M")).toEqual(["Marc-André", "Zoe"])
    expect(at("B")).toEqual(["Élodie", "Marc-André"])
    expect(at("प")).toEqual(["प्रियंका", "7even"])
    expect(at("#")).toEqual(["7even"])
  })

  it("refuses a cursor it did not write", () => {
    expect(byName(rows, { limit: 2, cursor: "not-a-cursor" })).toBe("bad_cursor")
  })
})

describe("parseFrom", () => {
  it.each([
    ["m", "M"],
    ["M", "M"],
    ["प", "प"],
    ["#", "#"],
  ])("accepts %s as %s", (raw, head) => expect(parseFrom(raw)).toBe(head))

  it.each(["", "MM", "7", "★", "ab"])("refuses %p", (raw) => expect(parseFrom(raw)).toBe("bad_from"))

  it("is undefined when absent", () => expect(parseFrom(null)).toBeUndefined())
})
