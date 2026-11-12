import { readFileSync } from "fs"
import { join } from "path"

// The module is imported for its exported helpers only; nothing here sends.
jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("expo-server-sdk", () => ({ Expo: class {} }))

import { notifyMatch, notifyReveal, notifyRevealRequest } from "@/lib/push-notifications"

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

/*
 * The three moments in a match that happen while the app is closed.
 *
 * The rule these all serve: **a lock screen is not an authenticated surface.**
 * The design doc names Indian venues and women in the room as the sensitive
 * case, and shared or borrowed phones are part of that same picture — a dating
 * match visible to whoever picks the phone up is a real-world safety problem,
 * not a UX preference.
 *
 * Nothing here would fail loudly if it regressed. A name would simply start
 * appearing on lock screens.
 */

describe("the match push names a room pseudonym and nothing else (approval 7, P-A, 2026-11-12)", () => {
  /*
   * The owner's copy is "You and {pseudonym} both waved". The one thing it may
   * interpolate is the pseudonym the conversation snapshotted -- what the room
   * already called them -- never a real name, a photo or an id, even for
   * somebody who revealed. Pinned at the call site, because the leak would
   * arrive as a different argument.
   */
  const push = read("lib/push-notifications.ts")
  const start = push.indexOf("export async function notifyMatch")
  const fn = push.slice(start, push.indexOf("\n}\n", start))

  it("interpolates exactly one value, the pseudonym parameter", () => {
    expect(fn).toContain("body: `You and ${pseudonym} both waved`")
    expect(fn).toContain('title: "You both waved"')
    expect(fn.match(/\$\{/g)).toHaveLength(1)
  })

  it("is handed the snapshotted pseudonym of the one who just tapped, never a name", () => {
    const src = read("lib/matches.ts")
    expect(src).toMatch(/notifyMatch\(likedId, conversation\.id, byUser\.get\(likerId\) \|\| "Attendee"\)/)
    // `byUser` is the pseudonym snapshot the conversation was opened with.
    expect(src).toMatch(/const byUser = new Map\(pseudonymRows\.map\(\(p\) => \[p\.user_id, p\.anonymous_name \|\| "Attendee"\]\)\)/)
  })
})

describe("no notification body carries an identity", () => {
  const bodies = [
    ["reveal request", notifyRevealRequest],
    ["reveal", notifyReveal],
  ] as const

  it.each(bodies)("%s carries no interpolation at all", async (_label, fn) => {
    /*
     * Asserted on the SOURCE rather than the call, because the failure mode is
     * somebody adding a `${name}` later. A static string cannot leak; a
     * template literal is where the leak would arrive.
     */
    const src = read("lib/push-notifications.ts")
    const start = src.indexOf(`export async function ${fn.name}`)
    expect(start).toBeGreaterThan(-1)

    const body = src.slice(start, start + 700)
    expect(body).not.toMatch(/title: `/)
    expect(body).not.toMatch(/body: `/)
    expect(body).not.toContain("Name")
    expect(body).not.toContain("pseudonym")
  })

  it("each takes only a recipient and a conversation id (the match push also its pseudonym, above)", () => {
    // No name parameter to pass means no name to accidentally interpolate.
    expect(notifyMatch).toHaveLength(3)
    expect(notifyRevealRequest).toHaveLength(2)
    expect(notifyReveal).toHaveLength(2)
  })

  it("each carries conversationId so the app can deep-link", () => {
    // Identity lives in the app, behind auth. The notification's only job is to
    // get them there in one tap.
    const src = read("lib/push-notifications.ts")
    for (const type of ["match", "reveal_request", "reveal"]) {
      expect(src).toMatch(new RegExp(`type: "${type}", conversationId`))
    }
  })
})

describe("the match notification goes to the person who does not know yet", () => {
  const src = read("lib/matches.ts")

  it("notifies the earlier liker, not the one who just tapped", () => {
    /*
     * `likedId` is the one who liked first — that is exactly what the `back`
     * lookup proved. The person who just tapped Like is holding the phone and
     * gets the mutual in the response, so pushing to them is a notification for
     * something they are already looking at.
     */
    expect(src).toMatch(/notifyMatch\(likedId, conversation\.id,/)
    expect(src).not.toMatch(/notifyMatch\(likerId/)
  })

  it("is fire-and-forget, so a push failure cannot fail the like", () => {
    expect(src).toMatch(/notifyMatch\(.*\)\.catch\(/)
  })

  it("only fires on a mutual, after the conversation exists", () => {
    // Before `back` there is no match, and before `openConversation` there is
    // no id to deep-link to.
    const backCheck = src.indexOf("if (!back) return { mutual: false }")
    expect(src.indexOf("notifyMatch(")).toBeGreaterThan(backCheck)
  })
})

describe("the reveal notifications go to the other side", () => {
  const src = read("app/api/mobile/conversations/[conversationId]/reveal/route.ts")

  it("notifies them, never the person who acted", () => {
    // Two call sites, both resolving `themId` from the caller's own side.
    const calls = src.match(/notify(Reveal|RevealRequest)\(themId, conversationId\)/g)
    expect(calls).toHaveLength(2)
  })

  it("is fire-and-forget on both paths", () => {
    expect(src.match(/notifyReveal(Request)?\([^)]*\)\.catch\(/g)).toHaveLength(2)
  })

  it("does not fire when the request was refused", () => {
    /*
     * Asking somebody already revealed returns 400 before the write. A
     * notification there would tell them somebody asked for something they had
     * already given.
     */
    const refusal = src.indexOf("They have already revealed")
    const notify = src.indexOf("notifyRevealRequest(")
    expect(refusal).toBeLessThan(notify)
  })

  it("does not fire when the reveal was refused for a missing photo", () => {
    const gate = src.indexOf("reveal_incomplete")
    const notify = src.indexOf("notifyReveal(themId")
    expect(gate).toBeLessThan(notify)
  })
})
