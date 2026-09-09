import { liveRequest, isLiveRequest } from "@/lib/board-access"

/**
 * When a board request stops being worth answering.
 *
 * The rule has two forms — a where clause for the cap, a predicate for a row
 * already read — and they are pinned against each other over real fixtures in
 * `board.itest.ts`. What is asserted here is the rule itself, and the one thing
 * about it that is silent when it breaks: the clock.
 *
 * Not in `negative-controls.json`. That registry tracks STRUCTURAL guards, the
 * ones that scan source text and can pass vacuously against broken code. These
 * call the functions, so they cannot match nothing. The controls were run all
 * the same — dropping `end_time` from `isLiveRequest` fails "the event ending
 * closes it", and hoisting the default `now` to a module constant fails "the
 * clock is read per call".
 */
const HOUR = 60 * 60 * 1000
const future = new Date(Date.now() + HOUR)
const past = new Date(Date.now() - HOUR)

const row = (over: Partial<{ status: string; end_time: Date; deleted_at: Date | null }> = {}) => ({
  status: over.status ?? "pending",
  event: { end_time: over.end_time ?? future },
  post: { deleted_at: over.deleted_at ?? null },
})

describe("what makes a request still worth answering", () => {
  it("takes a pending ask on an event that has not ended", () => {
    expect(isLiveRequest(row())).toBe(true)
  })

  it("the event ending closes it, which nothing else does", () => {
    /*
     * This is the defect. The only writers of `status` are a human deciding and
     * account deletion, so an ask about last year's event is `pending` for
     * ever. Counting those against the cap of five meant somebody could be
     * permanently unable to ask again, having done nothing wrong.
     */
    expect(isLiveRequest(row({ end_time: past }))).toBe(false)
  })

  it("a post taken down closes it too", () => {
    // The thing being answered is gone; there is no question left.
    expect(isLiveRequest(row({ deleted_at: new Date() }))).toBe(false)
  })

  it("an answered request was never live", () => {
    for (const status of ["accepted", "declined", "withdrawn"]) {
      expect(isLiveRequest(row({ status }))).toBe(false)
    }
  })

  it("reads the clock per call, not once at import", () => {
    /*
     * A module-level `new Date()` typechecks, passes every test above, and is
     * wrong by however long the process has been up — so on a server that has
     * been running a fortnight, every request looks live. That is the original
     * bug again, quieter, and it is why `liveRequest` is a function.
     */
    jest.useFakeTimers()
    try {
      jest.setSystemTime(new Date("2026-01-01T00:00:00Z"))
      const first = liveRequest().event.end_time.gt
      jest.setSystemTime(new Date("2026-06-01T00:00:00Z"))
      const second = liveRequest().event.end_time.gt
      expect(second.getTime()).toBeGreaterThan(first.getTime())
    } finally {
      jest.useRealTimers()
    }
  })

  it("honours a clock it is handed, so the page cannot disagree with itself", () => {
    /*
     * The list route takes one `now` for the whole page. Without that, the top
     * of a list and the bottom of it can answer differently about an event
     * ending mid-render — rare, and the kind of rare nobody reproduces.
     */
    const justAfter = new Date(future.getTime() + 1)
    expect(isLiveRequest(row(), justAfter)).toBe(false)
    expect(liveRequest(justAfter).event.end_time.gt).toBe(justAfter)
  })
})
