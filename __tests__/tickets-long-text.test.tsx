import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"

import { TypesPanel, type TypeRow } from "@/app/dashboard/events/[id]/tickets/types-panel"
import { formatCount, formatMinor } from "@/lib/money"

import { WORST } from "./support/long-text"

/*
 * The Tickets tab's long-text audit (owner, 2026-11-05): type names, prices and counts at their worst, driven at 1440 and
 * 375 with a seeded event. The board (tickets-tab-20261102/finalized.html) keeps tables on one line per cell and scrolls
 * them sideways; a name may wrap in its own cell; money never wraps.
 */

jest.mock("@/app/dashboard/events/[id]/tickets/actions", () => ({ saveTicketTypeForm: jest.fn() }))

const schedule = {
  version: 1 as const,
  market: "IN",
  currency: "INR",
  slabs: [{ fromTicket: 1, bps: 500 }],
  minFeeMinor: 1000,
  serviceTaxBps: 1800,
  processingBps: 236,
  takenAt: "2026-11-05T10:00:00.000Z",
}
const row = (over: Partial<TypeRow>): TypeRow => ({
  id: "t1",
  name: WORST.ticketType,
  priceMinor: WORST.inrMinor,
  quantity: WORST.bigCount,
  sold: WORST.count,
  held: 0,
  maxPerOrder: 10,
  hidden: false,
  windowLabel: "Until the event ends",
  startsLocal: "",
  endsLocal: "",
  ...over,
})
const panel = (types: TypeRow[]) =>
  renderToStaticMarkup(
    <TypesPanel eventId="e1" types={types} max={20} maxPerOrderCap={20} currency="INR" schedule={schedule} rule="standard" feesAbsorbed={false} paidTicketsBefore={0} />
  )
/** The class list of the element whose text content starts with `text`. */
const classOf = (html: string, tag: string, text: string) => {
  const at = html.indexOf(`>${text}`)
  expect(at).toBeGreaterThan(-1)
  const open = html.lastIndexOf(`<${tag}`, at)
  return /class="([^"]*)"/.exec(html.slice(open, at))?.[1] ?? ""
}

describe("ticket types", () => {
  it.each([WORST.ticketType, WORST.ticketTypeDevanagari])("%s wraps in its own cell, inside a table that scrolls sideways", (name) => {
    const html = panel([row({ name })])
    expect(classOf(html, "td", name)).toContain("break-words")
    expect(html).toMatch(/class="relative overflow-x-auto"><table/)
  })

  it("the price and the sold count stay whole: full numbers, never wrapped", () => {
    const html = panel([row({})])
    expect(classOf(html, "td", formatMinor(WORST.inrMinor, "INR"))).toContain("whitespace-nowrap")
    expect(formatMinor(WORST.inrMinor, "INR")).toBe("₹12,499")
    expect(html).toContain(`${formatCount(WORST.count)} / ${formatCount(WORST.bigCount)}`)
    expect(formatCount(WORST.bigCount)).toBe("12,40,000")
  })
})

describe("the Sales filters", () => {
  /*
   * A select is as wide as its longest option. With a long type name it ran past the panel at 375 (drive 2026-11-05);
   * held to the form's width it shows the start of the name and the full one in its list.
   */
  it("the selects are held to the form's width, so a long type name never pushes past the panel", () => {
    const source = readFileSync(join(__dirname, "../app/dashboard/events/[id]/tickets/page.tsx"), "utf8")
    const select = /const select = "([^"]+)"/.exec(source)?.[1] ?? ""
    expect(select.split(" ")).toEqual(expect.arrayContaining(["max-w-full", "min-w-0"]))
    expect(source).toMatch(/<select name="type"[^>]*className=\{select\}/)
  })
})

describe("the tables' sideways scroll", () => {
  /*
   * A screen-reader-only label ("Action", "Refund order …", "Edit {type}") is absolutely positioned. With no positioned
   * box inside the scroll wrapper it is placed against the page, not the table, so a table widened by long money or a
   * long type name pushed it past the viewport and the whole page scrolled 13 px sideways at 375 (drive 2026-11-05).
   */
  it.each(["page.tsx", "types-panel.tsx"])("every scroll wrapper in %s is the box its labels are placed in", (file) => {
    const source = readFileSync(join(__dirname, "../app/dashboard/events/[id]/tickets", file), "utf8")
    const wrappers = [...source.matchAll(/className="([^"]*overflow-x-auto[^"]*)"/g)].map((m) => m[1].split(" "))
    expect(wrappers.length).toBeGreaterThan(0)
    for (const classes of wrappers) expect(classes).toContain("relative")
  })
})

