import { readFileSync } from "fs"
import { join } from "path"

/**
 * A tab the event page offers must not be denied by where it leads.
 *
 * `event-tabs.tsx` builds Chat and Attendees from `canOperate`, under a comment
 * saying in as many words: *"a tab list that offers something the server will
 * deny is its own bug."* Both tabs redirect to `/messaging`, and that route
 * gated on **`canEdit`** and redirected to `/dashboard/chatrooms`.
 *
 * So a venue owner clicked a tab their own page had just offered and landed on
 * the global chatrooms list **showing a different event**. Not a refusal — a
 * silent arrival somewhere else. Driven on staging as the owner of QA Stadium,
 * on an event another organisation runs there, on a page whose card promises
 * "you get the live view, the attendee count and the chatroom".
 *
 * Every endpoint that page's right column calls — messages, message delete,
 * member mute, the moderation queue and its decisions — already gated on
 * `canOperate`. The API was right and the page was not.
 *
 * Source text rather than a rendered assertion: what is being pinned is which
 * predicate each side reaches for, and that is the thing that silently drifted.
 */
const ROOT = join(__dirname, "..")
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const TABS = read("app/dashboard/events/[id]/event-tabs.tsx")
const EVENT_PAGE = read("app/dashboard/events/[id]/page.tsx")
const MESSAGING = read("app/dashboard/events/[id]/messaging/page.tsx")

describe("the tab list and its destination agree", () => {
  it("found all three files, so the assertions below are not vacuous", () => {
    expect(TABS).toContain("eventTabsFor")
    expect(EVENT_PAGE).toContain("eventTabsFor(")
    expect(MESSAGING).toContain("eventPermissions(")
  })

  it("offers Chat and Attendees on canOperate", () => {
    expect(TABS).toContain("opts.canOperate")
    expect(TABS).toContain('key: "attendees"')
    expect(TABS).toContain('key: "chat"')
  })

  it("lets canOperate into the page those tabs lead to", () => {
    /*
     * The exact line that was wrong. `canEdit` here is what turned an offered
     * tab into a redirect to another event's page.
     */
    expect(MESSAGING).toContain("if (!permissions.canOperate) redirect")
    expect(MESSAGING).not.toMatch(/canEdit\)\s*\{?\s*redirect/)
  })

  it("keeps the composer and the sponsor panel behind canEdit", () => {
    /*
     * The other half, and the reason the predicate could not simply be flipped.
     * A venue owner announcing into an event they do not run is K3.12, and R37
     * removes that right deliberately.
     */
    const guarded = MESSAGING.match(/permissions\.canEdit \? \(([\s\S]*?)\) : null/)
    expect(guarded).not.toBeNull()
    expect(guarded![1]).toContain("EventSponsors")
    expect(guarded![1]).toContain("EventMessaging")
  })

  it("leaves the chat feed and the moderation queue outside that guard", () => {
    // What `canOperate` is defined as: "chat, moderation, the attendee list —
    // what happens in your building".
    const guarded = MESSAGING.match(/permissions\.canEdit \? \(([\s\S]*?)\) : null/)
    expect(guarded![1]).not.toContain("ChatFeed")
    expect(guarded![1]).not.toContain("ModerationQueue")
    expect(MESSAGING).toContain("<ChatFeed")
    expect(MESSAGING).toContain("<ModerationQueue")
  })
})
