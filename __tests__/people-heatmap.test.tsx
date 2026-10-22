import { renderToStaticMarkup } from "react-dom/server"

import { PeopleHeatmap } from "@/components/dashboard/venue-insights-panels"

describe("PeopleHeatmap", () => {
  it("draws a held-back cell as <5 and a quiet one as empty, never both as zero", () => {
    const people = Array.from({ length: 7 }, () => [0, 0, 0, 0]) as (number | null)[][]
    people[4][2] = null // Friday evening: 1 to 4 people, held back
    people[5][2] = 12
    const html = renderToStaticMarkup(<PeopleHeatmap people={people} />)
    expect(html).toContain('title="Fri evening: fewer than 5 people"')
    expect(html).toContain("&lt;5")
    expect(html).toContain('title="Fri morning: 0 people"')
  })
})
