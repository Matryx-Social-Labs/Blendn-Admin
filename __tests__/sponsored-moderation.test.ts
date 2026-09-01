import {
  canActivate,
  creativeEditPatch,
  touchesCreative,
} from "@/lib/sponsored-moderation"

/**
 * The edit-while-active bypass, and the seven reasons a campaign cannot run.
 *
 * Moderation runs at create and edit time rather than per send, because a
 * campaign fires every twenty minutes and re-checking identical bytes twenty
 * times a night is waste. That trade is only safe if an edit invalidates the
 * approval — otherwise "create clean, get approved, activate, edit the words"
 * puts unreviewed text into a pseudonymous room with the approval still
 * attached.
 */

describe("touchesCreative — what invalidates an approval", () => {
  const current = { content: "Stay hydrated", media_url: null, media_type: null }

  it("treats changed content as an edit", () => {
    expect(touchesCreative({ content: "Buy our drink" }, current)).toBe(true)
  })

  it("does NOT treat an unchanged resubmit as an edit", () => {
    /*
     * A form that posts every field on every save sends `content` even when the
     * user only moved the interval slider. Treating presence as change would
     * send every campaign back through review for a schedule tweak, which is
     * the kind of friction that teaches people to route around review.
     */
    expect(touchesCreative({ content: "Stay hydrated" }, current)).toBe(false)
  })

  it("does NOT treat an absent field as an edit", () => {
    expect(touchesCreative({}, current)).toBe(false)
  })

  it("treats explicit null as an edit, because removing media is a change", () => {
    const withMedia = { ...current, media_url: "https://x/y.jpg" }
    expect(touchesCreative({ media_url: null }, withMedia)).toBe(true)
  })

  it("catches a media swap even when the words are identical", () => {
    // The subtler half: same copy, different picture, same approval.
    const withMedia = { ...current, media_url: "https://x/old.jpg" }
    expect(touchesCreative({ media_url: "https://x/new.jpg" }, withMedia)).toBe(true)
  })
})

describe("creativeEditPatch — both halves, or neither is worth having", () => {
  it("forces pending AND deactivates", () => {
    /*
     * Resetting the status without deactivating leaves a live campaign sending
     * unreviewed copy until somebody notices. Deactivating without resetting
     * lets the next activation ride the old approval. The pair is the rule.
     */
    expect(creativeEditPatch()).toEqual({
      moderation_status: "pending",
      is_active: false,
    })
  })
})

describe("canActivate — a refusal that names its recovery", () => {
  const ok = {
    moderation_status: "approved" as const,
    sponsor_id: "s-1",
    hasChatGroup: true,
    placementApproved: true,
  }

  it("allows a campaign that is approved, branded, placed and has a room", () => {
    expect(canActivate(ok)).toEqual({ allowed: true })
  })

  it("refuses a campaign in review", () => {
    const d = canActivate({ ...ok, moderation_status: "pending" })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/review/i)
  })

  it("refuses a rejected creative and says to resubmit", () => {
    const d = canActivate({ ...ok, moderation_status: "rejected" })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/resubmit/i)
  })

  it("refuses a campaign with no brand", () => {
    // The due-select joins through sponsor_id; a null there means the campaign
    // would silently never send rather than erroring.
    const d = canActivate({ ...ok, sponsor_id: null })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/brand/i)
  })

  it("refuses when the placement is not approved", () => {
    const d = canActivate({ ...ok, placementApproved: false })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/placement/i)
  })

  it("refuses when the event has no chatroom", () => {
    /*
     * This used to write `is_active: true`, return 200, and schedule nothing —
     * the switch read on and the toast said "Started sending" while no message
     * ever went out. An impossible state should be unreachable, not reported as
     * success.
     */
    const d = canActivate({ ...ok, hasChatGroup: false })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/chatroom/i)
  })

  it("always gives a reason when it refuses", () => {
    // A greyed-out switch with no explanation is a control that refuses and
    // does not say why.
    const cases = [
      { ...ok, moderation_status: "pending" as const },
      { ...ok, moderation_status: "rejected" as const },
      { ...ok, sponsor_id: null },
      { ...ok, placementApproved: false },
      { ...ok, hasChatGroup: false },
    ]
    for (const c of cases) {
      const d = canActivate(c)
      expect(d.allowed).toBe(false)
      expect(d.reason && d.reason.length).toBeGreaterThan(10)
    }
  })
})
