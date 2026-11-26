/**
 * A named table's scroll box is a focusable, named region, so a table that
 * scrolls sideways on a phone is reachable by keyboard (axe
 * scrollable-region-focusable on /dashboard at 375, SCRUM-1281). An unnamed
 * table adds no tab stop.
 */
import { renderToStaticMarkup } from "react-dom/server"

import { Table } from "@/components/ui/table"

const box = (html: string) => /<div[^>]*data-slot="table-container"[^>]*>/.exec(html)?.[0] ?? ""

it("makes a named table's box a focusable region with the table's name", () => {
  const html = box(renderToStaticMarkup(<Table aria-label="Sign-ups by week" />))
  expect(html).toContain('role="region"')
  expect(html).toContain('tabindex="0"')
  expect(html).toContain('aria-label="Sign-ups by week"')
})

it("leaves an unnamed table's box alone", () => {
  const html = box(renderToStaticMarkup(<Table />))
  expect(html).not.toContain("tabindex")
  expect(html).not.toContain("role=")
})
