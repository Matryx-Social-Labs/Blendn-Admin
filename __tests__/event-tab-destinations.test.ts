import { readFileSync } from "fs"
import { join } from "path"

/**
 * A tab the event page offers must not be denied by where it leads.
 *
 * `event-tabs.tsx` builds Chat and Attendees from `canOperate`, under a comment
 * saying in as many words: *"a tab list that offers something the server will
 * deny is its own bug."* Both tabs used to redirect to `/messaging`, and that
 * route gated on **`canEdit`** and redirected to `/dashboard/chatrooms`. Chat
 * still leads there. Attendees renders on the event page itself since
 * SCRUM-499, and `eventAttendees` answers a venue owner with a count rather
 * than refusing them; `event-attendees-page.test.tsx` holds that.
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
 * Since step 15 all three of the event's routes load through one loader
 * (`lib/event-page.ts`), Room chat holds the feed and the moderation queue, and
 * the composer and sponsors are the Announcements & sponsors tab — `canEdit`'s,
 * in the tab list and again on the page, because a URL is not a tab list.
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
const FEEDBACK = read("app/dashboard/events/[id]/feedback/page.tsx")
const LOADER = read("lib/event-page.ts")

/** The body of `if (activeTab === "<key>") { … }` in the event page, brace-matched. */
function branch(key: string): string {
  const at = EVENT_PAGE.indexOf(`if (activeTab === "${key}") {`)
  if (at < 0) return ""
  let depth = 0
  for (let i = EVENT_PAGE.indexOf("{", at); i < EVENT_PAGE.length; i++) {
    if (EVENT_PAGE[i] === "{") depth++
    else if (EVENT_PAGE[i] === "}" && --depth === 0) return EVENT_PAGE.slice(at, i + 1)
  }
  return ""
}

describe("the tab list and its destination agree", () => {
  it("found every file, so the assertions below are not vacuous", () => {
    expect(TABS).toContain("eventTabsFor")
    expect(EVENT_PAGE).toContain("eventTabsFor(")
    expect(LOADER).toContain("eventPermissions(")
    expect(branch("announcements")).toContain("EventMessaging")
  })

  it("offers Room chat and Attendees on canOperate, and Announcements on canEdit", () => {
    expect(TABS).toContain("opts.canOperate")
    expect(TABS).toContain('key: "attendees"')
    expect(TABS).toContain('key: "chat"')
    expect(TABS).toMatch(/if \(opts\.canEdit\) tabs\.push\(\{ key: "announcements"/)
  })

  it("lets canOperate into every page those tabs lead to — one loader, asked the same way", () => {
    /*
     * The exact line that was wrong. `canEdit` here is what turned an offered
     * tab into a redirect to another event's page.
     */
    expect(LOADER).toContain("if (!permissions.canOperate) redirect")
    expect(LOADER).not.toMatch(/canEdit\)\s*\{?\s*redirect/)
    for (const page of [EVENT_PAGE, MESSAGING, FEEDBACK]) expect(page).toMatch(/await loadEventPage\(id\)/)
  })

  it("keeps the composer and the sponsor panel behind canEdit, on the page as well as in the tab list", () => {
    /*
     * The other half, and the reason the predicate could not simply be flipped.
     * A venue owner announcing into an event they do not run is K3.12, and R37
     * removes that right deliberately. A URL is not a tab list, so the branch
     * asks again.
     */
    const announcements = branch("announcements")
    expect(announcements).toMatch(/if \(!permissions\.canEdit\) redirect/)
    expect(announcements.indexOf("if (!permissions.canEdit)")).toBeLessThan(announcements.indexOf("<EventMessaging"))
    expect(announcements).toContain("<EventSponsors")
    // Nowhere else on the event's pages.
    for (const page of [MESSAGING, FEEDBACK, EVENT_PAGE.replace(announcements, "")]) {
      expect(page).not.toContain("<EventMessaging")
      expect(page).not.toContain("<EventSponsors")
    }
  })

  it("puts the chat feed and the moderation queue on the Room page, behind nothing but canOperate", () => {
    // What `canOperate` is defined as: "chat, moderation, the attendee list —
    // what happens in your building".
    expect(MESSAGING).toContain("<ChatFeed")
    expect(MESSAGING).toContain("<ModerationQueue")
    expect(MESSAGING).not.toMatch(/canEdit/)
  })
})
