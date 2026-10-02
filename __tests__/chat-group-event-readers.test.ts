import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

/**
 * Every reader of a room's event knows the room might not have one (TQ-A10,
 * CR-G02, F8).
 *
 * `chat_groups.event_id` was NOT NULL: every room was an event's. Now a crew,
 * Blend or board-post room has none, and the type says so — so a reader that
 * forgets fails to compile. What the compiler cannot stop is the two ways a
 * hurried fix makes it compile:
 *
 *   - a stand-in: `chat_group.event ?? { status: "published", deleted_at: null }`,
 *     `|| {…}` or `chat_group.event!`, which opens a room nobody owns;
 *   - a new reader in a file nobody looked at, which treats every room as an
 *     event's (`toChatRoom` silently dropping a room's messages was one).
 *
 * So the first is refused everywhere, and every dereference of a room's
 * `event` / `event_id` is counted per file against the list below, each with
 * why it is right for every kind. A new one fails until somebody decides.
 *
 * ponytail: names, not types — a read through a variable not called
 * `chat_group`, `chatGroup`, `group` or `room` (or a destructure) is not seen.
 * A ts-morph pass over the `chat_groups` type if that ever lets one through.
 */

const ROOT = join(__dirname, "..")
const SEARCH = ["app", "lib", "components", "scripts"]

const READ = /\b(?:chat_group|chatGroup|group|room)\??\.(?:event|event_id)\b/g
const ROOM = String.raw`\b(?:chat_group|chatGroup|group|room)\??`
/**
 * A default for the event (`?? {…}`, `|| {…}`, but not `!room.event || deny`),
 * a non-null assertion, or a default id that is not null.
 */
const STAND_IN = new RegExp(
  [
    String.raw`(?<!!)${ROOM}\.event\s*(?:\?\?|\|\|)`,
    String.raw`${ROOM}\.event(?:_id)?!(?!=)`,
    String.raw`${ROOM}\.event_id\s*(?:\?\?|\|\|)(?!\s*(?:null|undefined)\b)`,
  ].join("|"),
  "g"
)

/** File → how many reads, and why each is right for a room of any kind. */
const READERS: Record<string, { reads: number; why: string }> = {
  "lib/room-kind.ts": { reads: 10, why: "the door: switches on kind, and an event room without its event is refused" },
  "app/api/mobile/chat/groups/route.ts": {
    reads: 12,
    why: "lists event rooms only (kind: 'event' in the where), narrowed with nothing to fall back on",
  },
  "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts": {
    reads: 3,
    why: "sender names: a null event names a broadcast 'Organiser', never a person (roomSenderName)",
  },
  "app/api/mobile/chat/groups/[chatGroupId]/report/route.ts": {
    reads: 2,
    why: "a room report is filed against an event; a room of any other kind is refused",
  },
  "app/api/mobile/events/[eventId]/chat/route.ts": { reads: 2, why: "the room is found by its event; without it, no room" },
  "app/dashboard/moderation/actions.ts": { reads: 2, why: "the admin queue's label; no event reads 'Unknown event'" },
  "app/dashboard/moderation/reports/actions.ts": { reads: 2, why: "the admin queue's label; no event stays null" },
  "lib/polls.ts": { reads: 5, why: "polls are an event room's: the URL's event must be the room's, else not found" },
  "lib/sentiment-sweeper.ts": { reads: 1, why: "selects event rooms only (kind = 'event')" },
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/** Comments replaced by spaces, so a sentence about `chat_groups.event_id` is not a read. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length))
}

function scan() {
  const files = [...SEARCH.flatMap((d) => sourceFiles(join(ROOT, d))), join(ROOT, "server.ts")]
  const reads: Record<string, number> = {}
  const standIns: string[] = []
  for (const full of files) {
    const file = relative(ROOT, full)
    const src = blankComments(readFileSync(full, "utf8"))
    const n = src.match(READ)?.length ?? 0
    if (n) reads[file] = n
    for (const m of src.matchAll(STAND_IN)) standIns.push(`${file}:${src.slice(0, m.index).split("\n").length}  ${m[0]}`)
  }
  return { files: files.length, reads, standIns }
}

describe("readers of a room's event (F8)", () => {
  const { files, reads, standIns } = scan()

  it("scans the tree", () => {
    expect(files).toBeGreaterThan(300)
  })

  it("never stands in for a missing event", () => {
    expect(standIns).toEqual([])
  })

  it("every read is in a file that decided, as many times as it decided", () => {
    const expected = Object.fromEntries(Object.entries(READERS).map(([f, r]) => [f, r.reads]))
    expect(reads).toEqual(expected)
  })
})
