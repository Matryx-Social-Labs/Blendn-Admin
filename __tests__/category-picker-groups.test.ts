import { groupByParent } from "@/components/event-form/basic-info-section"

/**
 * The category picker's grouping — the one piece of logic in the form section
 * that is not a render — pinned on the case its comment describes and nothing
 * tested: typing a PARENT's name keeps every child under it.
 */
const sports = { id: "sports", name: "Sports", parent_id: null, parent: null }
const ipl = { id: "ipl", name: "IPL screening", parent_id: "sports", parent: { name: "Sports" } }
const f1 = { id: "f1", name: "F1 screening", parent_id: "sports", parent: { name: "Sports" } }
const music = { id: "music", name: "Live music", parent_id: null, parent: null }

describe("groupByParent", () => {
  it("a parent-name match keeps the whole group, not only the item called that", () => {
    const groups = groupByParent([sports, ipl, f1, music], "sport")
    expect(groups.map((g) => g.label)).toEqual(["Sports"])
    expect(groups[0].items.map((i) => i.id)).toEqual(["sports", "ipl", "f1"])
  })

  it("a child-name match keeps only that child, under its parent's label", () => {
    const groups = groupByParent([sports, ipl, f1, music], "f1")
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe("Sports")
    expect(groups[0].items.map((i) => i.id)).toEqual(["f1"])
  })

  it("a child whose parent relation is gone groups under its own name, not nowhere", () => {
    const orphan = { id: "ipl", name: "IPL screening", parent_id: "gone", parent: null }
    const groups = groupByParent([orphan, music], "")
    expect(groups.map((g) => g.label).sort()).toEqual(["IPL screening", "Live music"])
  })

  it("no filter returns every group in label order", () => {
    expect(groupByParent([music, sports, ipl], "").map((g) => g.label)).toEqual([
      "Live music",
      "Sports",
    ])
  })
})
