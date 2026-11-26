import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { StageCell } from "@/components/dashboard/overview-admin"
import type { CohortStage } from "@/lib/loop-closure"

/*
 * A cohort cell (SCRUM-1281). Not yet known is not zero, and a count under 5
 * is "a few" with no share beside it, nor a share of a base of a few: the two
 * together would give the count away.
 */
const cell = (stage: CohortStage, withBase = false) =>
  renderToStaticMarkup(createElement(StageCell, { stage, withBase })).replace(/<[^>]+>/g, "|")

it("says not yet known, never a number, when nobody has had the window", () => {
  const html = renderToStaticMarkup(createElement(StageCell, { stage: null, withBase: false }))
  expect(html).toContain('<span aria-hidden="true">—</span>')
  expect(html).toContain('<span class="sr-only">not yet known</span>')
  expect(html).not.toMatch(/\d/)
})

it("shows a real zero as 0, with its share", () => {
  expect(cell({ count: 0, of: 58 })).toBe("0|0%|")
})

it("shows a few under 5, and no share", () => {
  expect(cell({ count: 3, of: 96 })).toBe("a few")
})

it("hides the share when the base itself is a few", () => {
  expect(cell({ count: 0, of: 4 })).toBe("0")
})

it("names the base in a source's cell", () => {
  expect(cell({ count: 3105, of: 7512 }, true)).toBe("3,105|41% of 7,512|")
  expect(cell({ count: 12480, of: 12480 })).toBe("12,480|100%|")
})
