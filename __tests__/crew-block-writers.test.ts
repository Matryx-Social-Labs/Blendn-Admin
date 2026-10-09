import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

/**
 * Every writer of a block, every route that closes a conversation (an unmatch
 * keeps two people apart like a block, C6), and every unfriend, withdraws the
 * crew invites between the two people (C5, lib/crews/blocks.ts
 * `dropCrewInvitesBetween`); the closers also take the pair out of the Blends
 * that now refuse them (`evictBlockedFromBlends`).
 *
 * An invite is a friend asking. One left standing after a block lets the
 * blocked person accept into a crew with the person who blocked them — the
 * accept re-checks under the crew lock, but the invite would still sit on
 * their screen naming a friend who no longer is one. There are three block
 * writers today (the block route, a conversation's leave-and-block, a message
 * request's block) and two unfriend paths; a fourth writer added without the
 * call is what this catches.
 */

const ROOT = join(__dirname, "..")
const WRITES_BLOCK = /blocked_users\.(upsert|create|createMany)\(/
const WITHDRAWS = /dropCrewInvitesBetween\(|severFriendship\(/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** The body of `export async function <name>` up to the next top-level function. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`)
  if (start < 0) return ""
  const next = source.indexOf("\nexport ", start + 1)
  return source.slice(start, next < 0 ? undefined : next)
}

describe("crew invites do not outlive a block or an unfriend", () => {
  const writers = [...sources(join(ROOT, "app")), ...sources(join(ROOT, "lib"))].filter((file) =>
    WRITES_BLOCK.test(readFileSync(file, "utf8"))
  )

  it("finds the block writers at all", () => {
    // Guards the guard: a scan that matched nothing would pass vacuously.
    expect(writers.length).toBeGreaterThanOrEqual(3)
  })

  it("has every writer of blocked_users withdraw the pair's crew invites", () => {
    const missing = writers.filter((file) => !WITHDRAWS.test(readFileSync(file, "utf8"))).map((f) => relative(ROOT, f))
    expect(missing).toEqual([])
  })

  it("has every route that closes a conversation withdraw them and take the pair out of their Blends (C6)", () => {
    // A closed conversation keeps two people apart like a block. The erasure
    // closes every conversation of a person who leaves every crew anyway.
    const closers = sources(join(ROOT, "app"))
      .filter((file) => /closeConversation\(|closed_reason:/.test(readFileSync(file, "utf8")))
      .filter((file) => !file.endsWith(join("account", "route.ts")))
    expect(closers.map((f) => relative(ROOT, f)).sort()).toEqual([
      "app/api/mobile/conversations/[conversationId]/leave/route.ts",
      "app/api/mobile/conversations/[conversationId]/route.ts",
      "app/api/mobile/users/[userId]/block/route.ts",
    ])
    const missing = closers
      .filter((file) => {
        const src = readFileSync(file, "utf8")
        return !WITHDRAWS.test(src) || !/evictBlockedFromBlends\(/.test(src)
      })
      .map((f) => relative(ROOT, f))
    expect(missing).toEqual([])
  })

  it("has both unfriend paths withdraw them too", () => {
    const friends = readFileSync(join(ROOT, "lib/friends.ts"), "utf8")
    for (const name of ["unfriend", "severFriendship"]) {
      expect(bodyOf(friends, name)).toMatch(/dropCrewInvitesBetween\(/)
    }
  })
})
