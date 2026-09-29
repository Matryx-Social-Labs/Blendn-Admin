import type { PrismaClient } from "@prisma/client"

import { normaliseSponsorName } from "../lib/sponsor-name"

/*
 * The seeds' brand lookups, keyed the way the product keys them (SCRUM-456).
 *
 * The seeds wrote `name.toLowerCase()` ("blue tokai") while the product writes
 * `normaliseSponsorName` ("bluetokai") and rewrites the key on every brand edit.
 * So a seed looking a brand up by its own key missed the product's row and made
 * a second "Blue Tokai" for the same organisation. The dashboard reads one brand
 * per organisation, as the claim rules promise, and the second one's placements,
 * including a proposal waiting on the sponsor, never showed.
 */
type Db = Pick<PrismaClient, "sponsors">

const LIVE = { deleted_at: null, merged_into: null }
const OLDEST = [{ created_at: "asc" as const }, { id: "asc" as const }]

/** A brand by name, under the product's key or the key the seeds used to write. */
export function findBrandByName(db: Db, name: string) {
  return db.sponsors.findFirst({
    where: { ...LIVE, name_key: { in: [normaliseSponsorName(name), name.toLowerCase()] } },
    orderBy: OLDEST,
  })
}

/**
 * The organisation's one brand: the one it owns, else the unowned one by that
 * name (claimed for it), else a new one. Another organisation's brand of the
 * same name is an error, not a fallback: returning it left this organisation
 * with no brand and hung its placements on someone else's.
 */
export async function ensureOrgBrand(
  db: Db,
  brand: { name: string; orgId: string; createdBy: string; claimedAt: Date; website?: string }
) {
  const owned = await db.sponsors.findFirst({ where: { ...LIVE, org_id: brand.orgId }, orderBy: OLDEST })
  if (owned) return owned
  const named = await findBrandByName(db, brand.name)
  if (named?.org_id) {
    throw new Error(`"${brand.name}" belongs to another organisation (${named.org_id}). Merge or rename it before seeding.`)
  }
  if (named) {
    return db.sponsors.update({
      where: { id: named.id },
      data: { org_id: brand.orgId, claimed_at: brand.claimedAt, name_key: normaliseSponsorName(named.name) },
    })
  }
  return db.sponsors.create({
    data: {
      name: brand.name,
      name_key: normaliseSponsorName(brand.name),
      org_id: brand.orgId,
      website: brand.website ?? null,
      claimed_at: brand.claimedAt,
      created_by: brand.createdBy,
    },
  })
}
