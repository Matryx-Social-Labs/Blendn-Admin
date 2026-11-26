// Relative imports: reached from server.ts through lib/reminder-sweeper.ts (build:server is plain tsc).
import { PLAN_MARKET } from "./billing-plans"
import { cityCatalogue, cityFor } from "./cities"
import { db } from "./db"
import { realEventsWhere } from "./event-kind"

/**
 * May this organisation buy a plan where it runs events? The one market rule
 * (SCRUM-1275): the free-window mail, the Plan page's Buy, every checkout
 * (`lib/billing-actions.ts`, SCRUM-1151) and analytics access (where it is
 * false nothing is locked, `lib/analytics-access.ts` rule 5, SCRUM-1277) ask
 * it, never a second rule.
 *
 * `organisations` has no country, so it is its events' and its venues' cities
 * (a venue owner's nights are venue days with no organisation, so its venues
 * are its only evidence), resolved through the catalogue as
 * `lib/ticketing-enable.ts` does, whatever the city's launch state. No, as soon
 * as one is in another market. A city the catalogue does not know (a typo, a
 * neighbourhood) and an organisation with neither say nothing, so they count as
 * India: an Indian host in an uncatalogued town can still buy. The cost is a
 * Canadian host whose every city is uncatalogued; the fix is a `match_names` row.
 * A draft is no evidence (SCRUM-1277): a Canadian host whose only event is a
 * draft is offered Buy until it publishes; an Indian host cannot open Analytics
 * with a Toronto draft.
 */
export function mayBuyIn(countries: readonly (string | null)[]): boolean {
  return countries.every((c) => c === null || c === PLAN_MARKET)
}

export async function mayBuyHere(orgId: string): Promise<boolean> {
  const [catalogue, events, venues] = await Promise.all([
    cityCatalogue(),
    // Published, cancelled or completed: never a draft, and never a deleted event. Not being able to buy here opens
    // Analytics (SCRUM-1277), so the evidence must cost something: a Toronto draft nobody sees would be a free pass.
    // `status` is a non-null enum, so `not` keeps every other row.
    db.events.findMany({
      where: { organizer_org_id: orgId, deleted_at: null, status: { not: "draft" }, ...realEventsWhere },
      select: { city: true },
      distinct: ["city"],
    }),
    db.venues.findMany({ where: { owner_org_id: orgId, deleted_at: null }, select: { city: true }, distinct: ["city"] }),
  ])
  return mayBuyIn([...events, ...venues].map((row) => cityFor(catalogue, row.city)?.country ?? null))
}
