import { readFileSync } from "fs"
import { join } from "path"

/**
 * The notifications centre — the invariants that fail silently if broken.
 *
 * Every one of these guards a *quiet* failure. There is no crash, no red
 * screen and no failing request behind any of them; the symptom is a
 * notification that simply never appears in somebody's bell, which nobody
 * notices until they ask why they missed something.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const SCHEMA = () => read("prisma", "schema.prisma")
const SENDER = () => read("lib", "push-notifications.ts")
const MIGRATION = () =>
  read("prisma", "migrations", "20260816010000_notifications_centre", "migration.sql")

/** The `type` union on `NotificationData`, parsed out of the source. */
function senderKinds(): string[] {
  const src = SENDER()
  const line = /type:\s*("(?:[a-z_]+)"\s*(?:\|\s*"(?:[a-z_]+)"\s*)*)/.exec(src)
  if (!line) throw new Error("could not find NotificationData['type'] in push-notifications.ts")
  return [...line[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
}

/** The `notification_kind` enum, parsed out of the Prisma schema. */
function schemaKinds(): string[] {
  const block = /enum notification_kind \{([^}]*)\}/.exec(SCHEMA())
  if (!block) throw new Error("notification_kind enum not found in schema.prisma")
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .sort()
}

describe("the kind enum and the sender agree", () => {
  it("lists exactly the same eleven kinds", () => {
    /*
     * A kind the sender emits and the enum does not accept is a write that
     * throws — inside `recordNotification`'s catch, which logs and swallows,
     * because a failed insert must not fail the check-in that triggered it.
     * So the notification is sent, the push arrives, and the centre is missing
     * a line, with nothing louder than a `logger.warn` to say so.
     */
    expect(schemaKinds()).toEqual(senderKinds())
  })

  it("the migration's enum matches the schema's", () => {
    // `prisma migrate deploy` runs the SQL, not the schema. If they disagree
    // the deployed database accepts a different set from the one the client
    // believes in, and the mismatch only shows up as a runtime insert error.
    const sql = /CREATE TYPE "notification_kind" AS ENUM \(([^)]*)\)/.exec(MIGRATION())
    expect(sql).not.toBeNull()
    const fromSql = [...sql![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(fromSql).toEqual(schemaKinds())
  })
})

describe("the row is written even when no push goes out", () => {
  it("records before the token lookup, not after", () => {
    /*
     * The three early returns in `sendPushNotification` are: notifications
     * turned off in settings, no device registered, and an expired token. All
     * three are reasons a push does not *arrive*, and none is a reason the
     * notification did not happen. Recording after them would make the centre
     * a log of successful deliveries, which is the opposite of somewhere you
     * look for what you missed.
     */
    const src = SENDER()
    const record = src.indexOf("await recordNotification(")
    const lookup = src.indexOf("const pushTokens = await getUserPushTokens(userId)")
    expect(record).toBeGreaterThan(-1)
    expect(lookup).toBeGreaterThan(-1)
    expect(record).toBeLessThan(lookup)
  })

  it("records every recipient of a bulk send, not just the reachable ones", () => {
    /*
     * `getBulkUserPushTokens` returns a map keyed only by users who have a
     * token and have not turned notifications off, so recording inside the
     * send loop would drop everybody else. An organiser's announcement is
     * exactly what somebody opens the bell to find.
     */
    const src = SENDER()
    const record = src.indexOf("Failed to record bulk notifications")
    const lookup = src.indexOf("const tokenMap = await getBulkUserPushTokens(userIds)")
    expect(record).toBeGreaterThan(-1)
    expect(record).toBeLessThan(lookup)
  })

  it("never lets a failed insert fail the send", () => {
    // Eleven `notify*` helpers are fire-and-forget: the send must not fail the
    // request that triggered it, and the record must not fail the send.
    const src = SENDER()
    expect(src).toContain("Failed to record notification")
    expect(src).toMatch(/catch \(error\) \{\s*logger\.warn\("Failed to record notification"/)
  })

  it("skips the row rather than guessing a kind", () => {
    // A caller with no `data.type` is sending something the centre has no
    // category for. Inventing one puts a mislabelled line in a feed forever.
    expect(SENDER()).toContain("if (!data?.type)")
  })
})

describe("the routes only ever reach the caller's own rows", () => {
  it("scopes every query by the token's user id", () => {
    /*
     * The shape of every identity leak this repo has had: `interestedPreview`
     * returned other people's faces to any authenticated caller, and the
     * dashboard chat route returned other people's messages. A notification
     * carries a title and a body that may name somebody, so it is exactly as
     * sensitive.
     */
    const feed = read("app", "api", "mobile", "notifications", "route.ts")
    const markRead = read("app", "api", "mobile", "notifications", "read", "route.ts")

    for (const src of [feed, markRead]) {
      // No route may take the user from the request.
      expect(src).not.toMatch(/searchParams\.get\(["']userId["']\)/)
      expect(src).toContain("user.userId")
    }

    /*
     * `updateMany` filtered on id alone would let anybody mark anybody's
     * notification read given a uuid. The `user_id` stays in the `where` even
     * when the caller names ids.
     */
    const where = markRead.slice(markRead.indexOf("updateMany"))
    expect(where.slice(0, where.indexOf("data:"))).toContain("user_id: user.userId")
  })

  it("does not overwrite an existing read timestamp", () => {
    // The column answers "when did they see this". A bell tapped twice must
    // not move the answer, so already-read rows are excluded by the filter.
    const markRead = read("app", "api", "mobile", "notifications", "read", "route.ts")
    const where = markRead.slice(markRead.indexOf("updateMany"))
    expect(where.slice(0, where.indexOf("data:"))).toContain("read_at: null")
  })
})

describe("the migration is deployable", () => {
  it("references the User table by the name Prisma actually gives it", () => {
    /*
     * The NextAuth model has no `@@map`, so the table is `"User"` —
     * capitalised and singular. `"users"` typechecks, passes review and fails
     * at `prisma migrate deploy`, which on Railway means the container dies on
     * its next boot.
     */
    expect(MIGRATION()).toContain('REFERENCES "User"("id")')
    expect(MIGRATION()).not.toContain('REFERENCES "users"')
  })

  it("cascades, so deleting an account takes the history", () => {
    expect(MIGRATION()).toContain("ON DELETE CASCADE")
  })

  it("indexes both questions the bell asks", () => {
    const sql = MIGRATION()
    expect(sql).toContain('"user_id", "created_at"')
    expect(sql).toContain('"user_id", "read_at"')
  })
})
