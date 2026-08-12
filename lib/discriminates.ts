/**
 * A block of negative tests proves nothing unless something also succeeded.
 *
 * This is a function rather than a habit because the habit failed twice.
 *
 * The photo SSRF matrix once reported seven refusals in a row and was
 * worthless: staging's bucket is `blendn-media-staging`, not `blendn-media`, so
 * every URL died on the hostname comparison before reaching the ownership check
 * it was written to exercise. A guard that had been deleted entirely would have
 * produced byte-identical output.
 *
 * The `rohan-ohan` pseudonym leak was the same shape. Every anonymity assertion
 * ran against seed data whose pseudonyms already contained real names, so no
 * assertion in that suite was capable of failing.
 *
 * Both look like passing test runs. The only thing that separates a real
 * refusal from an input that never arrived is whether *something else*, which
 * should have been accepted, was.
 */

export type Outcome = { label: string; accepted: boolean }

/**
 * Throws unless the outcomes contain at least one acceptance and one refusal.
 *
 * @returns a one-line summary, suitable as a test's detail string.
 */
export function assertDiscriminates(outcomes: readonly Outcome[]): string {
  if (outcomes.length === 0) {
    throw new Error("no outcomes were recorded — the check did not run")
  }

  const accepted = outcomes.filter((o) => o.accepted)
  const refused = outcomes.filter((o) => !o.accepted)

  if (accepted.length === 0) {
    throw new Error(
      `nothing was accepted, so the ${refused.length} refusals prove nothing — ` +
        `every input failed before reaching the check under test. ` +
        `Refused: ${refused.map((o) => o.label).join(", ")}`
    )
  }

  if (refused.length === 0) {
    throw new Error(
      `everything was accepted (${accepted.length}) — the guard is not running at all. ` +
        `Accepted: ${accepted.map((o) => o.label).join(", ")}`
    )
  }

  return `${accepted.length} accepted, ${refused.length} refused — the check discriminates`
}
