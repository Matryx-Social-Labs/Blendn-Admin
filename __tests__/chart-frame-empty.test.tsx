/*
 * An empty chart's message has room of its own (SCRUM-1051, found on the Live
 * tab's drive). The message is centred over the chart's ghost; an empty
 * Complaints list has no rows to be a ghost, so the body was 0 px tall and the
 * message floated over the heading above it.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { CategoryBars } from "@/components/dashboard/charts"

const render = (data: { category: string; count: number | null }[], empty: boolean) =>
  renderToStaticMarkup(createElement(CategoryBars, { title: "Complaints — last 30 min", data, empty, emptyText: "Nothing negative classified yet in this window." }))

describe("an empty chart", () => {
  it("keeps a body tall enough for its message when there is nothing under it", () => {
    const html = render([], true)
    expect(html).toContain("Nothing negative classified yet in this window.")
    expect(html).toMatch(/class="relative min-h-\d+"/)
  })

  it("adds nothing to a chart with rows (the control)", () => {
    expect(render([{ category: "entry_queue", count: 6 }], false)).toMatch(/class="relative"/)
  })
})
