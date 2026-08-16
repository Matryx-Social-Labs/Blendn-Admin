import { readFileSync } from "fs"
import { join } from "path"

/**
 * Connect — a message request, and the deliberate opposite of a like.
 *
 *   like     "I would talk to you"    private, symmetric, pseudonymous
 *   connect  "here is who I am, why"  immediate, one-sided, and it reveals you
 *
 * Two actions, two meanings. These pin the properties that keep them distinct,
 * because collapsing them is what makes either one dangerous.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const ROUTE = () => read("app", "api", "mobile", "message-requests", "route.ts")
const SCHEMA = () => read("prisma", "schema.prisma")

describe("a request must carry a reason", () => {
  it("requires the message", () => {
    /*
     * A request with no message is a like with a reveal stapled to it. It also
     * makes the recipient's decision impossible: "Someone wants to connect" is a
     * coin flip; "we both work in design" is answerable.
     */
    const route = ROUTE()
    expect(route).toContain("message: z.string().trim().min(1).max(500),")
    expect(route).not.toContain("message: z.string().trim().min(1).max(500).optional()")
  })

  it("trims before measuring, so whitespace is not a message", () => {
    expect(ROUTE()).toContain(".trim().min(1)")
  })
})

describe("the protections that were already there", () => {
  it("allows one request per pair, for all time", () => {
    /*
     * The strongest anti-harassment property in the feature, and it predates it:
     * decline a request and that person can never send another. Not per-event,
     * not per-month — ever.
     */
    const model = SCHEMA().slice(SCHEMA().indexOf("model message_requests"))
    expect(model.slice(0, model.indexOf("}"))).toContain("@@unique([sender_id, recipient_id])")
  })

  it("rate limits the sender", () => {
    // Otherwise one person works through the whole roster in a minute.
    expect(ROUTE()).toContain('userLimit("write", "message-request"')
  })

  it("requires having been in the same room", () => {
    /*
     * `haveSharedAnEvent` — and the reason is recorded on it: "Message requests
     * had no such test: any authenticated caller could request any user id,
     * which makes the whole product a directory of strangers rather than a way
     * to talk to people you met somewhere."
     *
     * Ever, not right now: the most ordinary use is thinking better of it on
     * the way home.
     */
    expect(ROUTE()).toContain("haveSharedAnEvent(authUser.userId, recipientId)")
  })

  it("refuses a blocked pair in either direction", () => {
    // Checked before the shared-event test, so a block is never leaked as
    // "you were never at the same event".
    expect(ROUTE()).toContain("blocked_users.findFirst")
  })
})

describe("connect reveals the sender, and that is the point", () => {
  it("sends the sender's real name and photo to the recipient", () => {
    /*
     * Deliberate, and the safety argument rather than a leak: the anonymity
     * exists to stop people being identified, not to let people send unsolicited
     * messages without accountability. Anonymous plus unsolicited is the
     * harassment shape.
     *
     * It is also what makes the recipient's decision possible, and what keeps
     * Connect legibly different from Like — which stays pseudonymous.
     *
     * If this ever becomes gated, the app's "they will see your name and photo"
     * copy is a lie and must change with it.
     */
    const list = read("app", "api", "mobile", "message-requests", "route.ts")
    const block = list.slice(list.indexOf("sender: {"))
    expect(block.slice(0, block.indexOf("}"))).toContain("name: true")
  })

  it("keeps the like pseudonymous, so the two stay different", () => {
    /*
     * `likeAtEvent` snapshots pseudonyms onto the conversation it opens. If a
     * like ever revealed, the two actions would collapse into one and the card
     * would carry two buttons that do the same thing.
     */
    expect(read("lib", "matches.ts")).toContain("pseudonyms: Object.fromEntries(")
  })
})
