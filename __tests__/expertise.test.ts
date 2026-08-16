import {
  EXPERTISE_BY_FIELD,
  MAX_EXPERTISE,
  expertiseFor,
  expertiseLabels,
  isExpertise,
  pruneExpertise,
  workFieldOf,
  workFieldsMissingExpertise,
} from "@/lib/expertise"
import { WORK_FIELDS } from "@/lib/work-fields"

/**
 * The specialism vocabulary.
 *
 * Two things can go wrong here and neither is visible in a diff: a field with
 * no list offers an empty picker that reads as a network failure, and a stored
 * slug outliving the work field that owned it puts "Neuro-design" under
 * "Finance & Banking".
 */

describe("every work field is accounted for", () => {
  it("has a list for each one, or is knowingly empty", () => {
    // The failure mode: a nineteenth work field is added, nobody adds a list,
    // and the picker is blank for everyone who chooses it.
    expect(workFieldsMissingExpertise()).toEqual([])
  })

  it("offers nothing for 'other', on purpose", () => {
    /*
     * "Something else" is the bucket for people the taxonomy failed.
     * Sub-dividing it would invent a structure they have already told us they
     * are outside of.
     */
    expect(expertiseFor("other")).toEqual([])
  })

  it("gives every other field something to pick", () => {
    for (const field of WORK_FIELDS) {
      if (field.slug === "other") continue
      expect(expertiseFor(field.slug).length).toBeGreaterThanOrEqual(8)
    }
  })

  it("keeps each list scrollable without a search box", () => {
    // Same reasoning as WORK_FIELDS' own eighteen: finer is more informative
    // and more identifying, which is the wrong trade in a pseudonymous room.
    for (const list of Object.values(EXPERTISE_BY_FIELD)) {
      expect(list.length).toBeLessThanOrEqual(11)
    }
  })
})

describe("slugs carry their scope", () => {
  it("prefixes every slug with the field that owns it", () => {
    /*
     * This is what lets a stored value be validated without a second column,
     * and it is why `pruneExpertise` can work at all.
     */
    for (const [workField, list] of Object.entries(EXPERTISE_BY_FIELD)) {
      for (const item of list) {
        expect(item.slug.startsWith(`${workField}_`)).toBe(true)
      }
    }
  })

  it("never repeats a slug across fields", () => {
    const all = Object.values(EXPERTISE_BY_FIELD).flatMap((l) => l.map((e) => e.slug))
    expect(new Set(all).size).toBe(all.length)
  })

  it("resolves a slug back to its field", () => {
    expect(workFieldOf("design_ux_research")).toBe("design")
    expect(workFieldOf("finance_venture")).toBe("finance")
    expect(workFieldOf("not_a_real_slug")).toBeNull()
  })

  it("lets the same word mean different things in different fields", () => {
    // "Research" is a real specialism in several fields and means something
    // different in each — which is the whole reason slugs are scoped.
    expect(workFieldOf("design_ux_research")).not.toBe(workFieldOf("data_ai_research"))
    expect(workFieldOf("healthcare_research")).toBe("healthcare")
  })
})

describe("no slug is an address", () => {
  const labels = Object.values(EXPERTISE_BY_FIELD).flatMap((l) => l.map((e) => e.label))

  it("names no seniority", () => {
    /*
     * A rung is not a subject, and a rung plus a field plus a city narrows a
     * room fast. This is the same rule that keeps job titles out of
     * `work_field`.
     */
    for (const label of labels) {
      expect(label).not.toMatch(/\b(principal|senior|junior|head|chief|lead|vp|director)\b/i)
    }
  })

  it("names no company", () => {
    // The failure `work_field` exists to prevent, one level down.
    for (const label of labels) {
      expect(label).not.toMatch(/\b(google|meta|amazon|swiggy|razorpay|zomato|flipkart)\b/i)
    }
  })
})

describe("labels, never slugs", () => {
  it("resolves stored slugs in the order given", () => {
    expect(expertiseLabels(["design_brand", "design_ux_research"])).toEqual([
      "Brand & Identity",
      "UX Research",
    ])
  })

  it("drops anything it cannot resolve rather than rendering it raw", () => {
    // A card showing "design_ux_research" is worse than a card showing one tag.
    expect(expertiseLabels(["design_brand", "retired_slug"])).toEqual(["Brand & Identity"])
  })

  it("survives null", () => {
    expect(expertiseLabels(null)).toEqual([])
    expect(expertiseLabels(undefined)).toEqual([])
  })
})

describe("pruneExpertise is what stops a fossil", () => {
  it("keeps what belongs to the field", () => {
    expect(pruneExpertise(["design_brand", "design_motion"], "design")).toEqual([
      "design_brand",
      "design_motion",
    ])
  })

  it("drops everything when the field changes", () => {
    /*
     * The case this exists for. Somebody moves from Design to Finance; without
     * this their card reads "Finance & Banking · UX Psychology" forever — a
     * fossil of an attribute they have changed, under a heading contradicting
     * it.
     */
    expect(pruneExpertise(["design_brand", "design_motion"], "finance")).toEqual([])
  })

  it("keeps only the ones that match, not all or nothing", () => {
    expect(pruneExpertise(["design_brand", "finance_venture"], "finance")).toEqual([
      "finance_venture",
    ])
  })

  it("caps at MAX_EXPERTISE", () => {
    // Somebody who ticks nine specialisms has described a person, not an
    // attribute, and a tag should fit several people.
    const many = EXPERTISE_BY_FIELD.software.map((e) => e.slug)
    expect(many.length).toBeGreaterThan(MAX_EXPERTISE)
    expect(pruneExpertise(many, "software")).toHaveLength(MAX_EXPERTISE)
  })

  it("deduplicates rather than spending a slot twice", () => {
    expect(pruneExpertise(["design_brand", "design_brand", "design_motion"], "design")).toEqual([
      "design_brand",
      "design_motion",
    ])
  })

  it("returns nothing when there is no field", () => {
    // Expertise without a field is unresolvable — it cannot be validated, and
    // the card has no line to put it under.
    expect(pruneExpertise(["design_brand"], null)).toEqual([])
  })

  it("rejects a slug that never existed", () => {
    expect(pruneExpertise(["'; DROP TABLE profiles; --"], "design")).toEqual([])
    expect(isExpertise("'; DROP TABLE profiles; --")).toBe(false)
  })

  it("is idempotent", () => {
    // It runs on every profile write, so applying it twice must not differ from
    // applying it once.
    const once = pruneExpertise(["design_brand", "design_motion"], "design")
    expect(pruneExpertise(once, "design")).toEqual(once)
  })
})
