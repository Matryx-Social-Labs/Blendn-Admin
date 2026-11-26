import { Client } from "pg"

/*
 * SCRUM-1221 (launch gate 4): the server's pool fails fast instead of queueing for ever, and its statements are capped.
 *
 * pg-pool's default `connectionTimeoutMillis` is 0, wait for ever: with every connection busy (one slow query, a
 * doors-open burst of 11-query fan-outs) a request queued with no limit, the app timed out at 15 s and retried into the
 * same queue. And nothing set `statement_timeout`, so one runaway statement held its connection for as long as it ran.
 *
 * Each case loads `lib/db` afresh, because the pool size is read when the module loads.
 */
type DbModule = typeof import("@/lib/db")

const HOLD = "SELECT 1 AS held FROM pg_sleep(10)"

function freshDb(env: Record<string, string | undefined>): DbModule {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  let mod: DbModule | undefined
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@/lib/db") as DbModule
  })
  return mod!
}

/** A side connection, outside the pool under test, to watch and cancel the hold. */
async function side<T>(sql: string): Promise<T[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    return (await client.query(sql)).rows as T[]
  } finally {
    await client.end()
  }
}

const holdRunning = `SELECT pid FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND query = '${HOLD}'`

async function waitForHold(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await side(holdRunning)).length > 0) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("the holding query never started")
}

const cancelHold = () => side(`SELECT pg_cancel_backend(pid) FROM (${holdRunning}) held`)

const failureText = (e: unknown) =>
  e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}` : String(e)

const saved = { max: process.env.DATABASE_POOL_MAX, statement: process.env.DATABASE_STATEMENT_TIMEOUT_MS }
afterAll(() => {
  freshDb({ DATABASE_POOL_MAX: saved.max, DATABASE_STATEMENT_TIMEOUT_MS: saved.statement })
})

describe("pool acquire timeout", () => {
  it("a query waiting for a connection of a full pool fails within ~5 s instead of hanging", async () => {
    const { db, closeDb } = freshDb({ DATABASE_POOL_MAX: "1", DATABASE_STATEMENT_TIMEOUT_MS: undefined })
    const hold = db.$queryRawUnsafe(HOLD).catch((e: unknown) => e)
    try {
      await waitForHold()
      const started = Date.now()
      const outcome = await Promise.race([
        db.$queryRaw`SELECT 1 AS second`.then(
          () => "resolved",
          (e: unknown) => e,
        ),
        new Promise((r) => setTimeout(() => r("still pending at 6.5 s"), 6_500)),
      ])
      const waited = Date.now() - started

      expect(failureText(outcome)).toMatch(/timeout exceeded when trying to connect/)
      expect(waited).toBeGreaterThanOrEqual(4_500)
      expect(waited).toBeLessThan(6_500)
    } finally {
      await cancelHold()
      await hold
      await closeDb()
    }
  }, 20_000)
})

describe("statement timeout", () => {
  it("with DATABASE_STATEMENT_TIMEOUT_MS set, Postgres cancels a longer statement (57014)", async () => {
    const { db, closeDb } = freshDb({ DATABASE_POOL_MAX: undefined, DATABASE_STATEMENT_TIMEOUT_MS: "200" })
    try {
      const [{ statement_timeout }] = await db.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`
      expect(statement_timeout).toBe("200ms")

      const outcome = await db.$queryRaw`SELECT 1 AS slept FROM pg_sleep(1)`.then(
        () => "completed",
        (e: unknown) => e,
      )
      expect(failureText(outcome)).toMatch(/57014|canceling statement due to statement timeout/)
    } finally {
      await closeDb()
    }
  })

  it("without the variable (scripts, seeds, backfills) there is no cap and the same statement completes", async () => {
    const { db, closeDb } = freshDb({ DATABASE_POOL_MAX: undefined, DATABASE_STATEMENT_TIMEOUT_MS: undefined })
    try {
      const [{ statement_timeout }] = await db.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`
      expect(statement_timeout).toBe("0")
      await expect(db.$queryRaw`SELECT 1 AS slept FROM pg_sleep(1)`).resolves.toEqual([{ slept: 1 }])
    } finally {
      await closeDb()
    }
  })

  it("a value that is not a whole number of milliseconds is refused, not silently ignored", async () => {
    const { db, closeDb } = freshDb({ DATABASE_POOL_MAX: undefined, DATABASE_STATEMENT_TIMEOUT_MS: "8s" })
    try {
      await expect(db.$queryRaw`SELECT 1`).rejects.toThrow(/DATABASE_STATEMENT_TIMEOUT_MS/)
    } finally {
      await closeDb()
    }
  })
})

describe("pool gauge", () => {
  it("poolStats reads the pool every module copy shares, through globalThis", async () => {
    const first = freshDb({ DATABASE_POOL_MAX: "3", DATABASE_STATEMENT_TIMEOUT_MS: undefined })
    try {
      await first.db.$queryRaw`SELECT 1`
      // A second copy of the module, as Next bundles one per layer while server.ts built the client.
      const second = freshDb({})
      expect(second.poolStats()).toEqual({ total: 1, idle: 1, waiting: 0 })
    } finally {
      await first.closeDb()
    }
    expect(first.poolStats()).toBeNull()
  })
})
