// Relative imports: reached from server.ts through lib/reminder-sweeper.ts (build:server is plain tsc).
import { PLAN_MARKET } from "./billing-plans"
import { cityCatalogue, cityFor, cityHolds, type Catalogue } from "./cities"
import { db } from "./db"
import { realEventsWhere } from "./event-kind"

/**
 * May this organisation buy a plan where it runs events? The one market rule
 * (SCRUM-1275): the free-window mail, the Plan page's Buy, every checkout
 * (`lib/billing-actions.ts`, SCRUM-1151) and analytics access (where it is
 * false nothing is locked, `lib/analytics-access.ts` rule 5, SCRUM-1277) ask
 * it, never a second rule.
 *
 * `organisations` has no country, so it is its events' and its venues' rows
 * (a venue owner's nights are venue days with no organisation, so its venues
 * are its only evidence), each read by `marketOf`, whatever the city's launch
 * state. No, as soon as one is in another market. A row that says nothing (an
 * uncatalogued city, no pin, a label its pin is not inside) and an organisation
 * with no rows count as India: an Indian host in an uncatalogued town can still
 * buy. The cost is a Canadian host whose every row says nothing; the fix is a
 * `match_names` row, or the pin.
 * A draft is no evidence (SCRUM-1277): a Canadian host whose only event is a
 * draft is offered Buy until it publishes; an Indian host cannot open Analytics
 * with a Toronto draft.
 */
export function mayBuyIn(countries: readonly (string | null)[]): boolean {
  return countries.every((c) => c === null || c === PLAN_MARKET)
}

/**
 * A listing's market: the country of the catalogued city its label names, only when its pin is inside that city's
 * box (SCRUM-1447). The label is free text its owner can type (`updateVenue`, an event's city), the pin is where the
 * door is: a "Toronto" label on a Bengaluru pin, or on no pin, says nothing. Null is "says nothing".
 *
 * Accepted residual: a listing whose label AND pin are both abroad still counts, and a host can make one: a venue
 * owner creates a venue there (owned at once; in a preview city nobody sees it), an organizer publishes an event
 * there, and either can move it back later (the answer is read now, never kept). Closing that needs the listing
 * verified, and nobody is locked before about March 2027 (register D-011, review 2027-02-01).
 *
 * Known gap the other way: a name the catalogue folds into a city but whose place is outside that city's box (a
 * Brampton or western Mississauga pin against Toronto's) says nothing, so that Canadian host is offered Buy. The fix
 * is the city's box, which is data (`/dashboard/markets`).
 */
export function marketOf(
  catalogue: Catalogue,
  row: { city: string | null; latitude: number | null; longitude: number | null }
): string | null {
  const city = cityFor(catalogue, row.city)
  if (!city || row.latitude === null || row.longitude === null) return null
  return cityHolds(city, row.latitude, row.longitude) ? city.country : null
}

export async function mayBuyHere(orgId: string): Promise<boolean> {
  const [catalogue, events, venues] = await Promise.all([
    cityCatalogue(),
    // Published, cancelled or completed: never a draft, and never a deleted event. Not being able to buy here opens
    // Analytics (SCRUM-1277), so the evidence must cost something: a Toronto draft nobody sees would be a free pass.
    // `status` is a non-null enum, so `not` keeps every other row.
    // No `distinct`: with the pin in the select nearly every row is distinct, and Prisma deduped in memory anyway.
    // ponytail: every live row of the organisation comes back (three columns, through the plain org-id indexes); at
    // thousands of events per organisation, select DISTINCT city, latitude, longitude in SQL (exact, never a rounded
    // pin: rounding can cross a box edge), then a partial index on the live rows if measured slow.
    db.events.findMany({
      where: { organizer_org_id: orgId, deleted_at: null, status: { not: "draft" }, ...realEventsWhere },
      select: { city: true, latitude: true, longitude: true },
    }),
    db.venues.findMany({ where: { owner_org_id: orgId, deleted_at: null }, select: { city: true, latitude: true, longitude: true } }),
  ])
  return mayBuyIn([...events, ...venues].map((row) => marketOf(catalogue, row)))
}
