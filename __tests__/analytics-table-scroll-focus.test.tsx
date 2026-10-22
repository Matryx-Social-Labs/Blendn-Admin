/**
 * The side-by-side table scrolls sideways under ~700 px (it is 640 px wide),
 * so its scroll box takes keyboard focus and has a name. Measured on staging
 * for TQ-X09 (SCRUM-526): axe `scrollable-region-focusable` on
 * /dashboard/analytics at 375 and 768, the only finding across 114 cells.
 */
import { renderToStaticMarkup } from "react-dom/server"

import { ComparisonTable } from "@/components/dashboard/analytics-panels"

const row = {
  eventId: "e1", title: "Sunset Social", startsAt: "2026-10-01T13:00:00.000Z",
  going: 12, came: 9, turnUpPct: 75, firstTimePct: 40, medianStayMin: 95, rating: 4.5,
}

it("gives the scrolling table's box focus and a name", () => {
  const html = renderToStaticMarkup(<ComparisonTable rows={[row]} />)
  const box = /<div[^>]*class="overflow-x-auto"[^>]*>/.exec(html)?.[0] ?? ""
  expect(box).toContain('tabindex="0"')
  expect(box).toContain('role="region"')
  expect(box).toMatch(/aria-label="[^"]+"/)
})
