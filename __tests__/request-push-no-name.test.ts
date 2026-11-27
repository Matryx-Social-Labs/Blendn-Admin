import { readFileSync } from "fs"
import { join } from "path"

/**
 * Launch gate 7, widened (DECISIONS 2026-11-25 night; SCRUM-1266): no push for a
 * conversation that began as a request shows a real name or a message preview.
 *
 * The two request pushes put `User.name` on the lock screen: "{name} wants to
 * connect" to the person asked, "{name} accepted your message request" to the
 * asker. A lock screen is not an authenticated surface; the app's request list
 * shows who, behind sign-in. The DM pushes that follow are pinned with the real
 * module in `push-policy.test.ts` and through the routes in
 * `integration/request-born-push.itest.ts`.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const REQUEST = () => read("app", "api", "mobile", "message-requests", "route.ts")
const RESPOND = () => read("app", "api", "mobile", "message-requests", "[requestId]", "respond", "route.ts")
const ACCOUNT = () => read("lib", "account-erasure.ts")

/** Every `sendPushNotification({ ... })` call's argument, as source. */
const pushCalls = (src: string): string[] =>
  [...src.matchAll(/sendPushNotification\(\{([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1])

/** The `title:` and `body:` lines of one call. */
const copyLines = (call: string): string[] => call.split("\n").filter((l) => /^\s*(title|body):/.test(l))

describe.each([
  ["POST /message-requests", REQUEST, "New message request", "Someone wants to connect"],
  ["POST /message-requests/:id/respond", RESPOND, "Message request accepted", "Your message request was accepted"],
])("%s pushes fixed words", (_route, source, title, body) => {
  it("its one push is the fixed title and body", () => {
    const calls = pushCalls(source())
    expect(calls).toHaveLength(1)
    expect(copyLines(calls[0])).toEqual([`title: "${title}",`, `body: "${body}",`].map((l) => expect.stringContaining(l)))
  })

  it("no title or body interpolates anything, so no name can reach it", () => {
    for (const line of pushCalls(source()).flatMap(copyLines)) expect(line).not.toMatch(/\$\{|`|\+|\.name/)
  })

  it("loads no name to put in it", () => {
    expect(source()).not.toMatch(/senderName|responderName/)
  })

  it("an erased account's old rows are redacted to these same words", () => {
    // Rows written before this change still carry a name; erasure rewrites them to what a new row says.
    expect(ACCOUNT()).toContain(`SET body = '${body}'`)
  })
})
