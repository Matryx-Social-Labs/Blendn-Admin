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
  },
})
