"use server"

import type { Prisma } from "@prisma/client"
import { revalidatePath } from "next/cache"

import { auditInTx } from "@/lib/audit-log"
import { buildCatalogue, cityFor, forgetCityCatalogue, type Catalogue, type LaunchState } from "@/lib/cities"
import { requireAdmin } from "@/lib/current-user"
import { db } from "@/lib/db"
import { realEventsWhere } from "@/lib/event-kind"
import { cityRowFrom, launchStateFrom, marketRowFrom, textFrom, type CityInput, type MarketInput } from "@/lib/market-input"
import { Refusal } from "@/lib/refusal"
import { openOnBlendnWhere } from "@/lib/venue-visibility"

/*
 * /dashboard/markets (travel P5, SCRUM-709): which countries and cities people
 * see, as rows. Every write is an admin's, in one transaction with its one audit
 * row, and clears the app's catalogue cache on this instance (others follow
 * within the minute `lib/cities.ts` caches for).
 *
 * The guard is the cities endpoint's invariant held at the source: a city set
 * live opens with what it lists, so it may not go live with nothing listed.
 * Supply is counted as `GET /events/cities` counts it: published public events
 * that have not ended, and venues open on Blendn, folded onto catalogue cities.
 */

const PATH = "/dashboard/markets"
/** ponytail: every previewer would be one read; past this the screen shows the first ones and the true count. */
const PREVIEWERS_SHOWN = 500

type Client = Prisma.TransactionClient | typeof db

export interface CityView {
  slug: string
  name: string
  region: string | null
  timezone: string
  /** As set on the city. */
  launchState: LaunchState
  /** What the app shows: the lower of the city's and its market's. */
  effectiveState: LaunchState
  isDefault: boolean
  /** The door age a licensed venue's event is pre-filled with here; null for none. */
  licensedMinAge: number | null
  upcomingEvents: number
  venues: number
}

export interface PreviewerView {
  userId: string
  email: string
  name: string | null
  addedAt: string
}

export interface MarketView {
  code: string
  name: string
  currency: string
  locale: string
  launchState: LaunchState
  cities: CityView[]
  previewers: PreviewerView[]
  previewerCount: number
}

async function catalogueIn(client: Client): Promise<Catalogue> {
  const [markets, cities] = await Promise.all([client.markets.findMany(), client.cities.findMany()])
  return buildCatalogue(markets, cities)
}

/** Upcoming listed events and listed venues per catalogue city slug. */
async function supplyBySlug(client: Client, catalogue: Catalogue): Promise<Map<string, { events: number; venues: number }>> {
  const [events, venues] = await Promise.all([
    client.events.groupBy({
      by: ["city"],
      where: { deleted_at: null, ...realEventsWhere, status: "published", visibility: "public", end_time: { gte: new Date() }, city: { not: null } },
      _count: { _all: true },
    }),
    client.venues.groupBy({
      by: ["city"],
      where: { deleted_at: null, status: "active", city: { not: null }, AND: [openOnBlendnWhere] },
      _count: { _all: true },
    }),
  ])
  const supply = new Map<string, { events: number; venues: number }>()
  const add = (city: string | null, key: "events" | "venues", n: number) => {
    const slug = cityFor(catalogue, city)?.slug
    if (!slug) return
    const now = supply.get(slug) ?? { events: 0, venues: 0 }
    supply.set(slug, { ...now, [key]: now[key] + n })
  }
  events.forEach((row) => add(row.city, "events", row._count._all))
  venues.forEach((row) => add(row.city, "venues", row._count._all))
  return supply
}

const isEmpty = (s: { events: number; venues: number } | undefined) => !s || (s.events === 0 && s.venues === 0)

/** After a committed save: the app reads the new rows, and the screen re-renders. */
function saved(): void {
  forgetCityCatalogue()
  revalidatePath(PATH)
}

export async function getMarkets(): Promise<{ markets: MarketView[] }> {
  await requireAdmin()
  const [marketRows, cityRows] = await Promise.all([db.markets.findMany({ orderBy: { sort: "asc" } }), db.cities.findMany()])
  const catalogue = buildCatalogue(marketRows, cityRows)
  const supply = await supplyBySlug(db, catalogue)
  const previewers = await Promise.all(
    marketRows.map((m) =>
      Promise.all([
        db.market_previewers.findMany({
          where: { market_code: m.code },
          orderBy: { created_at: "desc" },
          take: PREVIEWERS_SHOWN,
          select: { created_at: true, user: { select: { id: true, email: true, name: true } } },
        }),
        db.market_previewers.count({ where: { market_code: m.code } }),
      ])
    )
  )
  const own = new Map(cityRows.map((c) => [c.slug, c]))

  return {
    markets: marketRows.map((m, i) => ({
      code: m.code,
      name: m.name,
      currency: m.currency,
      locale: m.locale,
      launchState: m.launch_state,
      cities: catalogue.cities
        .filter((c) => c.country === m.code)
        .map((c) => ({
          slug: c.slug,
          name: c.name,
          region: own.get(c.slug)?.region ?? null,
          timezone: c.timezone,
          launchState: own.get(c.slug)!.launch_state,
          effectiveState: c.launchState,
          isDefault: c.isDefault,
          licensedMinAge: own.get(c.slug)?.default_licensed_min_age ?? null,
          upcomingEvents: supply.get(c.slug)?.events ?? 0,
          venues: supply.get(c.slug)?.venues ?? 0,
        })),
      previewers: previewers[i][0].map((p) => ({ userId: p.user.id, email: p.user.email, name: p.user.name, addedAt: p.created_at.toISOString() })),
      previewerCount: previewers[i][1],
    })),
  }
}

export async function setCityState(slugArg: string, state: LaunchState): Promise<void> {
  const user = await requireAdmin()
  const slug = textFrom(slugArg)
  const to = launchStateFrom(state)
  const changed = await db.$transaction(async (tx) => {
    const city = await tx.cities.findUnique({ where: { slug }, select: { id: true, name: true, launch_state: true } })
    if (!city) throw new Refusal("No such city.")
    if (city.launch_state === to) return false
    if (to === "live" && isEmpty((await supplyBySlug(tx, await catalogueIn(tx))).get(slug))) {
      throw new Refusal(`${city.name} can’t go live: it has no upcoming listed events and no listed venues. List an event or a venue in ${city.name} first.`)
    }
    await tx.cities.update({ where: { id: city.id }, data: { launch_state: to } })
    await auditInTx(tx, { userId: user.id, action: "city.state_changed", resource: "city", resourceId: city.id, details: { slug, from: city.launch_state, to } })
    return true
  })
  if (changed) saved()
}

export async function setMarketState(codeArg: string, state: LaunchState): Promise<void> {
  const user = await requireAdmin()
  const code = textFrom(codeArg)
  const to = launchStateFrom(state)
  const changed = await db.$transaction(async (tx) => {
    const market = await tx.markets.findUnique({ where: { code }, select: { name: true, launch_state: true } })
    if (!market) throw new Refusal("No such country.")
    if (market.launch_state === to) return false
    if (to === "live") {
      const catalogue = await catalogueIn(tx)
      const supply = await supplyBySlug(tx, catalogue)
      const live = await tx.cities.findMany({ where: { market_code: code, launch_state: "live" }, select: { slug: true, name: true }, orderBy: { sort: "asc" } })
      const empty = live.find((c) => isEmpty(supply.get(c.slug)))
      if (empty) throw new Refusal(`${market.name} can’t go live: ${empty.name} is set to live with nothing listed. Set it to preview, or list an event or a venue there first.`)
    }
    await tx.markets.update({ where: { code }, data: { launch_state: to } })
    await auditInTx(tx, { userId: user.id, action: "market.state_changed", resource: "market", resourceId: code, details: { from: market.launch_state, to } })
    return true
  })
  if (changed) saved()
}

export async function createCity(input: CityInput): Promise<void> {
  const user = await requireAdmin()
  const row = cityRowFrom(input)
  await db.$transaction(async (tx) => {
    if (!(await tx.markets.findUnique({ where: { code: row.market_code }, select: { code: true } }))) {
      throw new Refusal("Choose a country from the list.")
    }
    if (await tx.cities.findUnique({ where: { slug: row.slug }, select: { id: true } })) throw new Refusal("That slug is taken.")
    // A name another city already answers to would be silently ignored (`buildCatalogue` keeps the first).
    const catalogue = await catalogueIn(tx)
    const holder = [row.name, ...row.match_names].map((n) => cityFor(catalogue, n)).find(Boolean)
    if (holder) throw new Refusal(`${holder.name} already answers to one of those names.`)
    const last = await tx.cities.aggregate({ where: { market_code: row.market_code }, _max: { sort: true } })
    const city = await tx.cities.create({ data: { ...row, launch_state: "hidden", sort: (last._max.sort ?? -1) + 1 }, select: { id: true } })
    await auditInTx(tx, { userId: user.id, action: "city.created", resource: "city", resourceId: city.id, details: { slug: row.slug, market: row.market_code, timezone: row.timezone } })
  })
  saved()
}

export async function createMarket(input: MarketInput): Promise<void> {
  const user = await requireAdmin()
  const row = marketRowFrom(input)
  await db.$transaction(async (tx) => {
    const existing = await tx.markets.findUnique({ where: { code: row.code }, select: { name: true } })
    if (existing) throw new Refusal(`${existing.name} is already a market.`)
    const last = await tx.markets.aggregate({ _max: { sort: true } })
    await tx.markets.create({ data: { ...row, launch_state: "hidden", sort: (last._max.sort ?? -1) + 1 } })
    await auditInTx(tx, { userId: user.id, action: "market.created", resource: "market", resourceId: row.code, details: { ...row } })
  })
  saved()
}

/** Returns the address the account holds, for the confirmation: never the typed text. */
export async function addPreviewer(codeArg: string, email: string): Promise<{ email: string }> {
  const user = await requireAdmin()
  const code = textFrom(codeArg)
  const address = textFrom(email, 320).trim().toLowerCase()
  const added = await db.$transaction(async (tx) => {
    const market = await tx.markets.findUnique({ where: { code }, select: { name: true } })
    if (!market) throw new Refusal("No such country.")
    // Exact, as sign-in matches (lib/auth.ts): `mode: "insensitive"` is ILIKE, where a typed % or _ finds somebody else.
    const person = await tx.user.findUnique({ where: { email: address }, select: { id: true, email: true } })
    if (!person) throw new Refusal("No Blendn account uses that email.")
    const key = { user_id_market_code: { user_id: person.id, market_code: code } }
    if (await tx.market_previewers.findUnique({ where: key, select: { user_id: true } })) {
      throw new Refusal(`${person.email} already previews ${market.name}.`)
    }
    await tx.market_previewers.create({ data: { user_id: person.id, market_code: code } })
    await auditInTx(tx, { userId: user.id, action: "market.previewer_added", resource: "market", resourceId: code, details: { previewerId: person.id } })
    return { email: person.email }
  })
  saved()
  return added
}

export async function removePreviewer(codeArg: string, userIdArg: string): Promise<void> {
  const user = await requireAdmin()
  const code = textFrom(codeArg)
  const userId = textFrom(userIdArg)
  await db.$transaction(async (tx) => {
    const { count } = await tx.market_previewers.deleteMany({ where: { market_code: code, user_id: userId } })
    if (count === 0) throw new Refusal("They don’t preview this country.")
    await auditInTx(tx, { userId: user.id, action: "market.previewer_removed", resource: "market", resourceId: code, details: { previewerId: userId } })
  })
  saved()
}
