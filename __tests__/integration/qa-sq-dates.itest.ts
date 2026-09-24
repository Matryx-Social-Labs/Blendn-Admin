/*
 * `qa sq` prints dates and timestamps as stored (SCRUM-295).
 *
 * On a Mac at UTC+2 a birth date of 2010-01-01 read back as
 * 2009-12-31T23:00:00.000Z and a 20:27Z deletion as 18:27Z: the pg driver
 * parses `date` and zone-less `timestamp` in the local zone, and the tool
 * printed toISOString(). A read-back that is wrong invents defects, and one
 * nearly got filed. Run in a zone far from UTC so the shift cannot hide.
 */
process.env.TZ = "Asia/Kolkata"

import { formatRows, sq } from "../../scripts/qa"

beforeAll(() => {
  process.env.QA_DATABASE_URL = process.env.DATABASE_URL
})

it("prints a date, a zone-less timestamp and a timestamptz as the database holds them", async () => {
  const rows = await sq(
    "SELECT '2010-01-01'::date AS d, '2026-09-24 20:27:19.217'::timestamp AS t, '2026-09-24 20:27:19.217+00'::timestamptz AS tz"
  )
  expect(formatRows(rows)).toEqual(["2010-01-01|2026-09-24T20:27:19.217Z|2026-09-24T20:27:19.217Z"])
})

it("leaves every other type as it was", async () => {
  const rows = await sq("SELECT 17::int AS n, 'x'::text AS s, NULL::date AS nd, ARRAY['a','b']::text[] AS arr, true AS b")
  expect(formatRows(rows)).toEqual(['17|x|null|["a","b"]|true'])
})
