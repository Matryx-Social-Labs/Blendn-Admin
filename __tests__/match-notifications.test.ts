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

describe("no notification body carries an identity", () => {
  const bodies = [
    ["match", notifyMatch],
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

  it("each takes only a recipient and a conversation id", () => {
    // No name parameter to pass means no name to accidentally interpolate.
    expect(notifyMatch).toHaveLength(2)
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
    expect(src).toMatch(/notifyMatch\(likedId, conversation\.id\)/)
    expect(src).not.toMatch(/notifyMatch\(likerId/)
  })

  it("is fire-and-forget, so a push failure cannot fail the like", () => {
    expect(src).toMatch(/notifyMatch\([^)]*\)\.catch\(/)
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
