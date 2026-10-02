/**
 * The organiser overview's "Getting set up" list, derived from what the
 * database already says — never from a tick somebody gave themselves.
 *
 * Only steps with a row behind them are here. The kit also asks "Put the QR
 * code on screen", and nothing records a code being shown or printed, so it
 * would be a tick that could only ever be invented.
 */
export interface SetupFacts {
  /** The home organisation (oldest live membership), or null for none. */
  org: {
    name: string
    kind: "individual" | "company"
    /** The first domain the organisation claimed, verified or not. */
    domain: { name: string; verified: boolean } | null
    /** Anyone else a member, or an invite ever sent that was not revoked. */
    colleagues: boolean
  } | null
  /** Any event of the organisation's ever published (or since completed). */
  published: boolean
}

export interface SetupStep {
  key: "org" | "domain" | "publish" | "colleague"
  label: string
  done: boolean
  /** Where the step is done. */
  href: string
}

export function setupChecklist(facts: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [
    {
      key: "org",
      label: facts.org ? `Set up ${facts.org.name}` : "Join or set up your organisation",
      done: facts.org !== null,
      href: "/dashboard/organisation",
    },
  ]
  /*
   * A company proves its domain and brings colleagues. An individual
   * organiser on a personal address has no domain to verify and nobody to
   * invite, and a step they can never finish would sit unticked forever.
   */
  if (facts.org?.kind === "company") {
    steps.push({
      key: "domain",
      label: facts.org.domain ? `Verify ${facts.org.domain.name}` : "Verify your email domain",
      done: facts.org.domain?.verified ?? false,
      href: "/dashboard/organisation",
    })
  }
  steps.push({
    key: "publish",
    label: "Publish an event",
    done: facts.published,
    href: "/dashboard/events/new",
  })
  if (facts.org?.kind === "company") {
    steps.push({
      key: "colleague",
      label: "Invite a colleague",
      done: facts.org.colleagues,
      href: "/dashboard/organisation",
    })
  }
  return steps
}
