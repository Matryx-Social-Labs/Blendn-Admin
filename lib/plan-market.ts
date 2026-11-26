// Relative imports: reached from server.ts through lib/reminder-sweeper.ts (build:server is plain tsc).
import { PLAN_MARKET } from "./billing-plans"
import { cityCatalogue, cityFor } from "./cities"
import { db } from "./db"
import { realEventsWhere } from "./event-kind"

/**
 * May this organisation buy a plan where it runs events? The one market rule
 * (SCRUM-1275): the free-window mail asks it today; the Plan page's Buy and the
 * checkout (design/05) and the stay-open rule (insights/04) are to ask it too,
 * never a second rule.
 *
 * `organisations` has no country, so it is its events' cities, resolved through
 * the catalogue as `lib/ticketing-enable.ts` does. No, as soon as one is in
 * another market. A city the catalogue does not know (a typo, a neighbourhood)
 * and an organisation with no events say nothing, so they count as India: an
 * Indian host in an uncatalogued town can still buy. The cost is a Canadian
 * host whose every city is uncatalogued; the fix is a `match_names` row.
 */
export function mayBuyIn(countries: readonly (string | null)[]): boolean {
  return countries.every((c) => c === null || c === PLAN_MARKET)
}

export async function mayBuyHere(orgId: string): Promise<boolean> {
  const [catalogue, cities] = await Promise.all([
    cityCatalogue(),
    // Any status, so a draft is evidence too; never a deleted event, so a Toronto test night removed is no reason.
    db.events.findMany({
      where: { organizer_org_id: orgId, deleted_at: null, ...realEventsWhere },
      select: { city: true },
      distinct: ["city"],
    }),
  ])
  return mayBuyIn(cities.map((e) => cityFor(catalogue, e.city)?.country ?? null))
}
