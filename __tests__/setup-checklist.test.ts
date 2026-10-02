import { setupChecklist, type SetupFacts } from "@/lib/setup-checklist"

/*
 * "Getting set up" on the organiser overview (step 15): every tick is a fact
 * the database holds, and a step somebody can never finish is not offered.
 */

const company = (overrides: Partial<NonNullable<SetupFacts["org"]>> = {}): SetupFacts["org"] => ({
  name: "Nightshift Collective",
  kind: "company",
  domain: { name: "nightshift.in", verified: false },
  colleagues: false,
  ...overrides,
})

const keys = (facts: SetupFacts) => setupChecklist(facts).map((s) => [s.key, s.done])

describe("setupChecklist", () => {
  it("asks somebody with no organisation to join one, and to publish", () => {
    expect(keys({ org: null, published: false })).toEqual([
      ["org", false],
      ["publish", false],
    ])
    expect(setupChecklist({ org: null, published: false })[0].label).toBe("Join or set up your organisation")
  })

  it("gives a company its domain and a colleague, named, in the kit's order", () => {
    const steps = setupChecklist({ org: company(), published: true })
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ["org", true],
      ["domain", false],
      ["publish", true],
      ["colleague", false],
    ])
    expect(steps[0].label).toBe("Set up Nightshift Collective")
    expect(steps[1].label).toBe("Verify nightshift.in")
  })

  it("ticks the domain only once it is verified, and asks for one when none is claimed", () => {
    expect(keys({ org: company({ domain: { name: "x.in", verified: true } }), published: false })[1]).toEqual([
      "domain",
      true,
    ])
    const none = setupChecklist({ org: company({ domain: null }), published: false })
    expect(none[1]).toMatchObject({ key: "domain", done: false, label: "Verify your email domain" })
  })

  it("ticks a colleague once anyone else is in, or was asked", () => {
    expect(keys({ org: company({ colleagues: true }), published: false })[3]).toEqual(["colleague", true])
  })

  it("never offers an individual organiser a domain or a colleague they could not have", () => {
    expect(keys({ org: company({ kind: "individual" }), published: true })).toEqual([
      ["org", true],
      ["publish", true],
    ])
  })
})
