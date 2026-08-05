import { toCsv, reportFilename, csvResponse, UTF8_BOM } from "@/lib/csv"

/**
 * CSV export.
 *
 * Every failure here is silent in the worst way: the file downloads, opens, and
 * looks like a spreadsheet. A broken quote shifts one row's columns; a missing
 * BOM mangles every accented name; an unescaped formula runs code on the
 * machine of whoever opened it.
 */

describe("quoting, per RFC 4180", () => {
  const cols = [{ key: "a", label: "A" }, { key: "b", label: "B" }]

  it("leaves ordinary values bare", () => {
    expect(toCsv(cols, [{ a: "hello", b: "world" }])).toBe("A,B\r\nhello,world")
  })

  it("quotes a value containing the delimiter", () => {
    // Unquoted, "Bengaluru, India" becomes two columns and every later column
    // in that row shifts by one.
    expect(toCsv(cols, [{ a: "Bengaluru, India", b: "x" }])).toContain('"Bengaluru, India",x')
  })

  it("doubles inner quotes", () => {
    expect(toCsv(cols, [{ a: 'He said "hi"', b: "x" }])).toContain('"He said ""hi""",x')
  })

  it("quotes a value containing a newline", () => {
    // Event descriptions have newlines. Unquoted, one row becomes two and the
    // whole rest of the file is offset.
    const csv = toCsv(cols, [{ a: "line one\nline two", b: "x" }])
    expect(csv).toContain('"line one\nline two"')
  })

  it("uses CRLF between records", () => {
    expect(toCsv(cols, [{ a: "1", b: "2" }, { a: "3", b: "4" }])).toBe("A,B\r\n1,2\r\n3,4")
  })

  it("emits a header even with no rows", () => {
    // An empty export should be an empty spreadsheet, not an empty file that
    // reads as a failed download.
    expect(toCsv(cols, [])).toBe("A,B")
  })
})

describe("formula injection is neutralised", () => {
  const cols = [{ key: "title", label: "Title" }]

  it("prefixes a cell starting with =", () => {
    // Event titles come from the public side of this product. Opened in Excel,
    // `=cmd|'/c calc'!A1` executes.
    const csv = toCsv(cols, [{ title: "=cmd|'/c calc'!A1" }])
    expect(csv).toContain("'=cmd")
  })

  it("prefixes the other three formula starters", () => {
    for (const bad of ["+1+1", "-1+1", "@SUM(A1)"]) {
      const csv = toCsv(cols, [{ title: bad }])
      expect(csv).toMatch(/'[+\-@]/)
    }
  })

  it("leaves a legitimate leading character alone", () => {
    const csv = toCsv(cols, [{ title: "Sunday Session" }])
    expect(csv).toBe("Title\r\nSunday Session")
  })

  it("still quotes a neutralised cell that also contains a comma", () => {
    const csv = toCsv(cols, [{ title: "=A1,B2" }])
    expect(csv).toContain(`"'=A1,B2"`)
  })
})

describe("value types", () => {
  const cols = [{ key: "v", label: "V" }]

  it("writes dates as ISO, not locale", () => {
    // A report opened in another timezone must not shift every date by a day.
    const csv = toCsv(cols, [{ v: new Date("2026-08-05T10:30:00Z") }])
    expect(csv).toContain("2026-08-05T10:30:00.000Z")
  })

  it("writes an empty cell for null and undefined", () => {
    expect(toCsv(cols, [{ v: null }])).toBe("V\r\n")
    expect(toCsv(cols, [{ v: undefined }])).toBe("V\r\n")
  })

  it("writes numbers unquoted so they stay numbers", () => {
    expect(toCsv(cols, [{ v: 42 }])).toBe("V\r\n42")
  })

  it("writes an empty cell rather than the string NaN", () => {
    // "NaN" in a numeric column breaks every formula downstream of it.
    expect(toCsv(cols, [{ v: NaN }])).toBe("V\r\n")
    expect(toCsv(cols, [{ v: Infinity }])).toBe("V\r\n")
  })

  it("writes booleans as true/false", () => {
    expect(toCsv(cols, [{ v: false }])).toBe("V\r\nfalse")
  })

  it("uses a column's value function over the raw field", () => {
    const csv = toCsv([{ key: "n", label: "N", value: (r) => (r.n as number) * 2 }], [{ n: 21 }])
    expect(csv).toBe("N\r\n42")
  })
})

describe("the response", () => {
  it("leads with a BOM so Excel reads UTF-8", async () => {
    // Without it Excel uses the local codepage and every accented venue name
    // arrives mojibaked.
    //
    // Asserted on the bytes, not on `.text()`: the fetch spec has TextDecoder
    // strip a leading BOM while decoding, so the string round-trip cannot see
    // the thing being tested. EF BB BF is the UTF-8 encoding of U+FEFF.
    const res = csvResponse("x.csv", "A\r\nBengalūru")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
  })

  it("exports the BOM as an escape, not a stray literal", () => {
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff)
    expect(UTF8_BOM).toHaveLength(1)
  })

  it("sets the download headers", () => {
    const res = csvResponse("report.csv", "A")
    expect(res.headers.get("Content-Type")).toContain("text/csv")
    expect(res.headers.get("Content-Disposition")).toContain('filename="report.csv"')
  })

  it("forbids caching, because a report is a snapshot", () => {
    expect(csvResponse("x.csv", "A").headers.get("Cache-Control")).toBe("no-store")
  })

  it("strips quotes from the filename rather than breaking the header", () => {
    const res = csvResponse('we"ird.csv', "A")
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="weird.csv"')
  })
})

describe("reportFilename", () => {
  it("is sortable and says what it is", () => {
    const name = reportFilename("events", new Date("2026-07-01"), new Date("2026-08-05"))
    expect(name).toBe("blendn-events-2026-07-01_2026-08-05.csv")
  })

  it("collapses a single-day range", () => {
    const name = reportFilename("events", new Date("2026-08-05"), new Date("2026-08-05"))
    expect(name).toBe("blendn-events-2026-08-05.csv")
  })
})
