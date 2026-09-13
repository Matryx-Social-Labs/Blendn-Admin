/**
 * Where a curated event was listed, and what that says about who may claim it.
 *
 * ## The flag this exists for
 *
 * A claim is verified partly by matching the claimant's email domain against
 * the source URL the event was curated from. That is a good check when the
 * source is the organiser's own site, and a **catastrophic** one when it is a
 * ticketing aggregator: without this list, one address at a large ticketing
 * platform would match the source of every event on the platform curated from
 * it, and claim all of them.
 *
 * It is a flag, not a refusal. Somebody at an aggregator may legitimately run
 * an event; what they may not do is have the domain match count as evidence.
 * The reviewer sees `source_is_aggregator` and asks for something else.
 *
 * ## Deliberately short
 *
 * The same posture as `FREE_PROVIDERS` in `lib/org-invites.ts`: this decides
 * whether a claimant needs more proof, not whether they are honest. Anything
 * missing simply fails to raise a flag, and a human is still reading every one
 * of these — nothing auto-approves.
 *
 * Pure, so the rule is unit-testable without a database or a network.
 */

/** Whole domains, matched on the registrable part. Never a substring. */
const AGGREGATORS = new Set([
  // India
  "bookmyshow.com", "in.bookmyshow.com",
  "insider.in", "paytm.com", "paytminsider.com",
  "townscript.com", "meraevents.com", "zomato.com", "district.in",
  // International
  "eventbrite.com", "eventbrite.co.uk", "eventbrite.in",
  "ticketmaster.com", "dice.fm", "ra.co", "residentadvisor.net",
  "songkick.com", "bandsintown.com", "seetickets.com", "skiddle.com",
  "fatsoma.com", "shotgun.live", "luma.com", "lu.ma",
  "meetup.com", "facebook.com", "fb.com", "partiful.com",
])

/**
 * The registrable domain of a URL, lowercased. Null when it is not a URL.
 *
 * `www.` is stripped because it is never the distinguishing part, and a source
 * pasted from a browser bar carries it about half the time.
 */
export function sourceDomain(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    return host.startsWith("www.") ? host.slice(4) : host
  } catch {
    return null
  }
}

/**
 * Is this source a ticketing aggregator?
 *
 * Matches the host and its parent domains, so `in.bookmyshow.com` and
 * `events.eventbrite.co.uk` both resolve — a subdomain of an aggregator is an
 * aggregator, and listing every one of them is not a maintainable list.
 */
export function isAggregatorSource(url: string | null | undefined): boolean {
  return isAggregatorDomain(sourceDomain(url))
}

/**
 * The same question, asked of a bare host rather than a URL.
 *
 * An **application** carries an email domain, not a source URL, and
 * `bookings@in.bookmyshow.com` is exactly the case the aggregator list exists
 * to catch: one address at a ticketing platform could otherwise claim every
 * event on the platform. The applications queue rendered that domain in the
 * same filled badge it uses for `thehummingtree.com` — so the strongest
 * negative signal in the queue looked identical to the strongest positive one.
 *
 * Split out rather than duplicated, because the list must have one reader. A
 * second copy is how `in.bookmyshow.com` ends up on one list and not the other.
 */
export function isAggregatorDomain(host: string | null | undefined): boolean {
  if (!host) return false
  const lower = host.trim().toLowerCase().replace(/^www\./, "")

  // Matches the host and its parent domains, so `in.bookmyshow.com` and
  // `events.eventbrite.co.uk` both resolve — a subdomain of an aggregator is an
  // aggregator, and listing every one of them is not a maintainable list.
  const parts = lower.split(".")
  for (let i = 0; i < parts.length - 1; i++) {
    if (AGGREGATORS.has(parts.slice(i).join("."))) return true
  }
  return false
}
