jest.mock("@/lib/db", () => ({ db: {} }))

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { CategoryBars } from "@/components/dashboard/charts"
import { discloseCategories, discloseFigure, MAX_DOMINANCE } from "@/lib/disclosure"
import { tallyFeedback, type TallyRow } from "@/lib/feedback-digest"

/*
 * A complaint category one person wrote most of (SCRUM-1285).
 *
 * Categories floor on people, so five people clear it while one of them wrote
 * 20 of the 25 messages, and the host reads a number that is mostly one person.
 * The dominance rule (`MAX_DOMINANCE`) holds it back. The host is never told
 * why: a dominated category reads exactly as one under the people floor, and no
 * payload carries a reason (orchestrator ruling 1).
 */

const ROOM = 40

/** `messages[i]` negative messages in `category` from person i. */
const rows = (category: string, messages: number[]): TallyRow[] =>
  messages.flatMap((n, i) =>
    Array.from({ length: n }, () => ({ sentiment: "negative" as const, category: category as TallyRow["category"], topic: null, userId: `p${i}` }))
  )

const disclose = (...groups: TallyRow[][]) => {
  const t = tallyFeedback(groups.flat())
  return discloseCategories(t.categoryCounts, t.contributors, ROOM, t.topMessages)
}
const one = (category: string, messages: number[]) => disclose(rows(category, messages))[0]

describe("the largest single person's messages per category", () => {
  it("are counted from the rows the tally already reads", () => {
    const t = tallyFeedback([...rows("entry_queue", [20, 2, 1, 1, 1]), ...rows("crowding", [2, 2, 2, 2, 2])])
    expect(t.categoryCounts.get("entry_queue")).toBe(25)
    expect(t.contributors.get("entry_queue")).toBe(5)
    expect(t.topMessages.get("entry_queue")).toBe(20)
    expect(t.topMessages.get("crowding")).toBe(2)
  })

  it("never count a row whose author is gone as anybody's", () => {
    const t = tallyFeedback([...rows("entry_queue", [3]), { sentiment: "negative", category: "entry_queue", topic: null, userId: null }])
    expect(t.categoryCounts.get("entry_queue")).toBe(4)
    expect(t.topMessages.get("entry_queue")).toBe(3)
  })
})

describe("a category one person dominates", () => {
  it("is held back: 5 people, one with 20 of 25", () => {
    expect(one("entry_queue", [20, 2, 1, 1, 1])).toEqual({ category: "entry_queue", count: null, suppressed: true })
    // The reason exists for tests and logs, never in a payload.
    expect(discloseFigure({ count: 25, contributors: 5, population: ROOM, topContributorShare: 20 / 25 }).reason).toBe("dominance")
  })

  it("is shown when 5 people wrote evenly", () => {
    expect(one("entry_queue", [5, 5, 5, 5, 5])).toEqual({ category: "entry_queue", count: 25, suppressed: false })
  })

  it("is shown at exactly half: the rule is more than half (MAX_DOMINANCE)", () => {
    expect(MAX_DOMINANCE).toBe(0.5)
    expect(one("entry_queue", [10, 4, 3, 2, 1])).toEqual({ category: "entry_queue", count: 20, suppressed: false })
    expect(one("entry_queue", [11, 4, 3, 2, 1])).toEqual({ category: "entry_queue", count: null, suppressed: true })
  })

  it("is shown as today when the largest share is not known (a tally frozen before it was recorded)", () => {
    const t = tallyFeedback(rows("entry_queue", [20, 2, 1, 1, 1]))
    expect(discloseCategories(t.categoryCounts, t.contributors, ROOM, undefined)).toEqual([{ category: "entry_queue", count: 25, suppressed: false }])
  })
})

describe("what the host receives (ruling 1)", () => {
  const dominated = rows("entry_queue", [20, 2, 1, 1, 1])
  const fewPeople = rows("crowding", [3, 2])
  const [held, underFloor] = [disclose(dominated)[0], disclose(fewPeople)[0]]
  const rename = (c: object) => JSON.parse(JSON.stringify(c).replaceAll("entry_queue", "X").replaceAll("crowding", "X"))

  it("a dominated category is the same payload as one under the people floor, apart from its name", () => {
    expect(rename(held)).toEqual(rename(underFloor))
  })

  it("and renders the same, apart from its name", () => {
    const html = (c: typeof held) => renderToStaticMarkup(createElement(CategoryBars, { title: "What went wrong", data: [c] }))
    expect(html(held).replace("entry queue", "X")).toBe(html(underFloor).replace("crowding", "X"))
  })

  it("sorts where a held-back category sorts: after every shown one", () => {
    expect(disclose(dominated, rows("crowding", [1, 1, 1, 1, 1])).map((c) => c.category)).toEqual(["crowding", "entry_queue"])
  })

  it("carries no reason at all: no `suppressionReason` key, no 'dominance'", () => {
    const payload = JSON.stringify(disclose(dominated, fewPeople, rows("crowding", [1, 1, 1, 1, 1])))
    expect(payload).not.toContain("suppressionReason")
    expect(payload).not.toContain("dominance")
    expect(payload).not.toMatch(/min_cell|completeness|residual/)
  })
})

describe("a category nobody dominates (ruling 5)", () => {
  it("is the same payload with the largest share as without it", () => {
    const t = tallyFeedback([...rows("entry_queue", [5, 5, 5, 5, 5]), ...rows("crowding", [1, 1, 1, 1, 1, 1])])
    expect(discloseCategories(t.categoryCounts, t.contributors, ROOM, t.topMessages)).toEqual(
      discloseCategories(t.categoryCounts, t.contributors, ROOM, undefined)
    )
  })
})
