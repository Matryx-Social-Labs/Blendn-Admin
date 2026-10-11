/**
 * The admin-world fixtures refuse a database that is neither staging nor local
 * by themselves (step 18 security review, L6) — before a single query — rather
 * than relying on seed-qa having asked first.
 */
import type { PrismaClient } from "@prisma/client"

import { seedMatrixMarkers, seedTaxonomy } from "../scripts/seed-admin-world"

const touched: string[] = []
// Any property read on this "client" is a query that should never have run.
const db = new Proxy({}, { get: (_t, prop) => (touched.push(String(prop)), () => Promise.resolve(null)) }) as unknown as PrismaClient

const PRODUCTION = { RAILWAY_ENVIRONMENT_NAME: "production", DATABASE_URL: "postgresql://u:p@db.internal:5432/blendn" }
const REMOTE = { DATABASE_URL: "postgresql://u:p@db.example.com:5432/blendn" }

beforeEach(() => {
  touched.length = 0
})

it.each([["production", PRODUCTION], ["an unknown remote host", REMOTE]])("refuses %s, and queries nothing", async (_label, env) => {
  await expect(seedTaxonomy(db, env)).rejects.toThrow(/seed-admin-world: .*neither staging nor a local database/)
  await expect(seedMatrixMarkers(db, { admin: "a", attendees: [], brandId: "b" }, env)).rejects.toThrow(/seed-admin-world/)
  expect(touched).toEqual([])
})
