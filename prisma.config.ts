import "dotenv/config"
import { defineConfig } from "prisma/config"

/**
 * Prisma 7 removed `url` from the datasource block in schema.prisma. The CLI
 * (migrate, db push, studio) reads its connection string from here instead,
 * and the runtime client gets one through a driver adapter — see lib/db.ts.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    /*
     * Needed by anything that has to *replay* the migration chain rather than
     * read the live database: `migrate dev`, and `migrate diff
     * --from-migrations`, which is the only way to ask whether `schema.prisma`
     * has drifted from the migrations.
     *
     * Without it that question could not be asked at all — and it is the one
     * that matters here, because `db push` and `migrate deploy` do not produce
     * the same database. CLAUDE.md records three CHECK constraints that exist
     * in migration SQL and cannot be expressed in `schema.prisma`, so a pushed
     * database is strictly weaker than production and a comparison by columns
     * alone proves less than it appears to.
     *
     * Undefined when unset, which is what it has effectively been until now, so
     * no existing flow changes. Point it at a scratch database to use it:
     *   SHADOW_DATABASE_URL=postgres://…/shadow npx prisma migrate diff \
     *     --from-migrations prisma/migrations --to-schema prisma/schema.prisma
     */
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
