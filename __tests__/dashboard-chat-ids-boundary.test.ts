import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * The dashboard chat routes never hand a host an attendee's account id (SCRUM-517).
 *
 * They did, in three places — each message's `user.id`, each member's
 * `userId`, each flag's `userId` — written as `userId: m.user_id`, which looks
 * like nothing. The id is the same in every room, so a host across several
 * nights joined the people in them into one history. Every id a host gets is
 * now `idFor(...)`: the room's handle, or the real id for the admin.
 *
 * `__tests__/integration/dashboard-chat-no-user-ids.itest.ts` holds the wire.
 * This holds the source, so a new field written the old way fails here before
 * anybody has to think of asserting on it.
 */

const ROOT = join(__dirname, "..")
const CHAT = join(ROOT, "app", "api", "events", "[id]", "chat")

/**
 * A response field set straight from a row's account id. Not `session.user.id`:
 * that is the caller's own, which is theirs to have (the audit actor).
 */
const RAW_ID = /\b(?:id|userId|authorId|memberId)\s*:\s*(?!session\.)[A-Za-z_]\w*\.(?:user_id|user\.id)\b/

function routes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) routes(full, acc)
    else if (entry === "route.ts") acc.push(full)
  }
  return acc
}

describe("host-facing chat routes return handles, not account ids", () => {
  const files = routes(CHAT).map((abs) => [abs.replace(`${ROOT}/`, ""), stripComments(readFileSync(abs, "utf8"))] as const)

  it("finds the chat routes, so a moved directory cannot empty this test", () => {
    expect(files.map(([rel]) => rel)).toEqual(
      expect.arrayContaining([
        "app/api/events/[id]/chat/messages/route.ts",
        "app/api/events/[id]/chat/moderation/route.ts",
        "app/api/events/[id]/chat/members/[userId]/route.ts",
      ])
    )
  })

  it("sets no response field from a row's account id", () => {
    expect(files.filter(([, src]) => RAW_ID.test(src)).map(([rel]) => rel)).toEqual([])
  })

  it.each(["app/api/events/[id]/chat/messages/route.ts", "app/api/events/[id]/chat/moderation/route.ts"])(
    "%s shapes every id through idFor()",
    (rel) => {
      const src = files.find(([f]) => f === rel)?.[1] ?? ""
      expect(src).toMatch(/const idFor = \(userId: string\) =>\s*isPlatformAdmin \? userId : idForViewer\(session\.user\.id, eventId, userId\)/)
    }
  )

  it("reads a host's ref back only as this room's handle", () => {
    const src = files.find(([f]) => f.endsWith("members/[userId]/route.ts"))?.[1] ?? ""
    expect(src).toMatch(/roomMemberFromRef\(eventId, ref, session\.user\.id\)/)
  })

  it("maps a chat member's audit row to a handle for anybody but the admin", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib", "audit-actions.ts"), "utf8"))
    expect(src).toMatch(/resourceId: isAdmin \? r\.resource_id : hostResourceId\(session\.user\.id, r\)/)
  })

  // Negative controls: the rule sees the shapes it exists for, and not the fix.
  it.each([`userId: m.user_id,`, `id: m.user.id,`, `userId: f.user_id`, `authorId: row.user_id`])(
    "flags %s",
    (snippet) => expect(RAW_ID.test(snippet)).toBe(true)
  )
  it.each([`userId: idFor(m.user_id),`, `id: idFor(m.user.id),`, `user: { select: { id: true } }`, `where: { user_id: userId }`, `userId: session.user.id,`])(
    "passes %s",
    (snippet) => expect(RAW_ID.test(snippet)).toBe(false)
  )
})
