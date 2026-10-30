import { createEventBudget } from "@/lib/socket-budget"

/*
 * Every socket event ran with no limit, and typing / markRead each cost several
 * queries and a room-wide emit (SCRUM-940). The budget is per socket: a person
 * using the app never nears it, a loop does.
 */
describe("createEventBudget", () => {
  it("lets events through up to the cap within a window, then drops them", () => {
    const now = 1_000
    const allow = createEventBudget(3, 10_000, () => now)
    expect([allow(), allow(), allow(), allow(), allow()]).toEqual([true, true, true, false, false])
  })

  it("starts a fresh window once the old one has passed", () => {
    let now = 1_000
    const allow = createEventBudget(2, 10_000, () => now)
    allow()
    allow()
    expect(allow()).toBe(false)
    now += 10_000
    expect(allow()).toBe(true)
  })

  it("is per socket: one budget does not spend another's", () => {
    const a = createEventBudget(1, 10_000)
    const b = createEventBudget(1, 10_000)
    a()
    expect(a()).toBe(false)
    expect(b()).toBe(true)
  })
})
