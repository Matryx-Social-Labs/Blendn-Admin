/**
 * Remove perfseed data.
 *
 *   DATABASE_URL=... node scripts/clean-perfseed.mjs
 *
 * History of what did not work, so nobody repeats it:
 *   1. `WHERE user_id LIKE 'perfseed_%'` on chat_messages — unindexed pattern
 *      match over 500k rows, never finished.
 *   2. One cascade DELETE of all 2000 events — the statement ran past the
 *      proxy's patience and the connection dropped.
 *   3. ctid batches of 20k with retry-on-error — every batch was still too big,
 *      so the retry loop spun forever and deleted exactly nothing.
 *
 * What works: `statement_timeout = 0` on a raw pg connection, and batching the
 * PARENT rows (events, 100 at a time) so the FK cascade removes chat_groups,
 * chat_messages, members and check-ins for us. ~20 statements instead of
 * repeated ctid scans over half a million rows.
 *
 * Failures are fatal here, not retried. A retry loop that cannot make progress
 * looks identical to one that is working — that is how (3) hid for an hour.
 */
import { Client } from "pg"

const TAG = "perfseed"
const EVENT_BATCH = 100
const USER_BATCH = 2000

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  statement_timeout: 0,
})

const q = async (sql) => (await client.query(sql)).rowCount
const count = async (sql) => Number((await client.query(sql)).rows[0].n)

await client.connect()
await client.query("SET statement_timeout = 0")

console.log(
  `before: events=${await count(`SELECT count(*) n FROM events WHERE slug LIKE '${TAG}-%'`)}` +
    ` messages=${await count("SELECT count(*) n FROM chat_messages")}` +
    ` users=${await count(`SELECT count(*) n FROM "User" WHERE id LIKE '${TAG}_%'`)}`
)

// Events first: everything the seed created below an event (chat_groups ->
// chat_messages / members, check-ins, rsvps) goes with the FK cascade.
for (let done = 0; ; ) {
  const n = await q(
    `DELETE FROM events WHERE id IN (
       SELECT id FROM events WHERE slug LIKE '${TAG}-%' LIMIT ${EVENT_BATCH})`
  )
  if (n === 0) break
  done += n
  console.log(`  events -${n} (${done})`)
}

// profiles.id is the User id, so profiles go before the users they hang off.
for (const [label, sql] of [
  ["profiles", `DELETE FROM profiles WHERE id IN (SELECT id FROM profiles WHERE id LIKE '${TAG}_%' LIMIT ${USER_BATCH})`],
  ["users", `DELETE FROM "User" WHERE id IN (SELECT id FROM "User" WHERE id LIKE '${TAG}_%' LIMIT ${USER_BATCH})`],
]) {
  for (let done = 0; ; ) {
    const n = await q(sql)
    if (n === 0) break
    done += n
    console.log(`  ${label} -${n} (${done})`)
  }
}

// Without this the planner keeps statistics from 500k rows and picks index
// scans for tables that are back to a few hundred.
await client.query("ANALYZE")

console.log(
  `\nafter: events=${await count("SELECT count(*) n FROM events")}` +
    ` messages=${await count("SELECT count(*) n FROM chat_messages")}` +
    ` users=${await count('SELECT count(*) n FROM "User"')}` +
    ` checkins=${await count("SELECT count(*) n FROM event_check_ins")}` +
    ` leftover=${await count(`SELECT count(*) n FROM "User" WHERE id LIKE '${TAG}_%'`)}`
)
await client.end()
