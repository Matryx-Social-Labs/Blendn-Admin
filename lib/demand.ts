import { cityKey } from "./address"
import { db } from "./db"

/**
 * Which city to open next.
 *
 * ## The table that was written on every miss and read by nothing
 *
 * `city_demand` is fully instrumented — written every time somebody looks for
 * events where there are none, deleted on account erasure, and carrying an index
 * whose own comment calls it *"the only query this table exists for"*. Nothing
 * ever ran that query. This is it.
 *
 * ## C12: the table could not render the signal it collects
 *
 * The admin Cities list was built by **iterating events** and folding them by
 * city name, so a city with demand and zero events could not appear in it at
 * all. That is precisely the city the number is for: somewhere people are
 * looking and nobody is supplying. The list was structurally incapable of
 * showing the thing it existed to show.
 *
 * So the row set is the **union** of cities with events and cities with demand,
 * keyed on `cityKey` so "Bengaluru" and "bengaluru" are one row rather than two.
 */

/**
 * How many distinct people waiting makes a city worth opening.
 *
 * Not total demand, and the distinction is the product's: the unit is **a room
 * on a night**, so the threshold is a room's worth of people rather than a
 * market's worth of interest. Twenty-five is enough that a first event is not
 * six people in a large bar, which is the failure mode that kills a launch city
 * before it starts.
 *
 * A starting point, not a finding. It is a constant here rather than a literal
 * in a query so the first real launch can move it in one place.
 */
export const LAUNCH_READY = 25

export interface DemandRow {
  /** As shown to a user, so the dashboard renders a real place name. */
  city: string
  cityKey: string
  /** Distinct people who looked here and found nothing. */
  waiting: number
  /** Published events in this city. Zero is the interesting case. */
  events: number
  /**
   * Ready to open?
   *
   * Rendered as a decision rather than a number, because a metric with no
   * decision rule is a metric nobody acts on — which is how `city_demand` came
   * to be written for months and read never.
   */
  launchReady: boolean
}

/**
 * Cities with demand, with events, or both.
 *
 * One grouped query per side rather than a join, because the two live in
 * different shapes: demand is one row per person per city, events are one row
 * per event. Folding in memory over a few hundred cities is cheaper to read
 * than the SQL that would avoid it.
 */
export async function cityDemand(limit = 50): Promise<DemandRow[]> {
  const [demand, events] = await Promise.all([
    db.city_demand.groupBy({
      by: ["city_key"],
      _count: { user_id: true },
      // The measurement is one row per person per city, so a count of rows IS a
      // count of people -- guaranteed by @@unique([user_id, city_key]) rather
      // than by remembering. Noted because everywhere else in this codebase
      // that assumption was wrong.
      _max: { city: true },
      orderBy: { _count: { user_id: "desc" } },
      take: limit,
    }),
    db.events.groupBy({
      by: ["city"],
      where: { deleted_at: null, status: "published", city: { not: null } },
      _count: { _all: true },
    }),
  ])

  const rows = new Map<string, DemandRow>()

  for (const d of demand) {
    rows.set(d.city_key, {
      city: d._max.city ?? d.city_key,
      cityKey: d.city_key,
      waiting: d._count.user_id,
      events: 0,
      launchReady: false,
    })
  }

  for (const e of events) {
    const key = cityKey(e.city)
    if (!key) continue
    const existing = rows.get(key)
    if (existing) {
      existing.events += e._count._all
    } else {
      // A city with events and no recorded demand. It belongs in the list --
      // the list is "where are we", not only "where should we go".
      rows.set(key, {
        city: e.city as string,
        cityKey: key,
        waiting: 0,
        events: e._count._all,
        launchReady: false,
      })
    }
  }

  for (const row of rows.values()) {
    /*
     * Ready means people are waiting AND nobody is serving them. A city with
     * twenty-five waiting and forty events is not a launch opportunity, it is a
     * discovery problem -- and telling a founder to "open" it would send them
     * to do work that is already done.
     */
    row.launchReady = row.waiting >= LAUNCH_READY && row.events === 0
  }

  return [...rows.values()].sort(
    (a, b) => b.waiting - a.waiting || b.events - a.events || a.city.localeCompare(b.city)
  )
}

/**
 * The one number.
 *
 * Distinct people waiting in the best-served-by-nobody city. A single figure a
 * founder can act on, rather than a table they have to read.
 */
export async function topUnservedCity(): Promise<DemandRow | null> {
  const rows = await cityDemand(50)
  return rows.find((r) => r.events === 0 && r.waiting > 0) ?? null
}
