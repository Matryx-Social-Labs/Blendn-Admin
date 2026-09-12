import { readFileSync } from "fs"
import { join } from "path"

/**
 * The organiser's feed names the room's own voice.
 *
 * Driven on the dashboard (2026-09-12, Founders & Filter Coffee, as the
 * organiser): the organiser's own announcement and the sponsor's two sends all
 * rendered as messages from **"Attendee"** with an emoji line as the only
 * hint — the same string an attendee could type (K3.10). `type` cannot carry
 * the answer because a sponsored send keeps it for the media kind, so the
 * route derives `kind` and the feed labels the row with the word the phone
 * shows.
 */

const ROOT = join(__dirname, "..")
const read = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

describe("the dashboard feed knows a broadcast from a person", () => {
  it("derives `kind` from the sponsored marker and the announcement type", () => {
    const route = read("app/api/events/[id]/chat/messages/route.ts")
    expect(route).toMatch(/kind:\s*\(m\.metadata as[^)]*\)\?\.sponsored_message_id\s*\?\s*"sponsored"/)
    expect(route).toMatch(/m\.type === "announcement"\s*\?\s*"announcement"\s*:\s*"user"/)
  })

  it("labels the row instead of naming an Attendee", () => {
    const feed = read("components/chat-feed.tsx")
    expect(feed).toContain('const broadcast = msg.kind !== "user"')
    // The label is the word the phone shows, in the sender's place.
    expect(feed).toMatch(/broadcast \? \([\s\S]{0,300}\{msg\.kind === "sponsored" \? "Sponsored" : "Announcement"\}[\s\S]{0,300}\) : \([\s\S]{0,200}anonymousName \?\? "Attendee"/)
    // And the server's label line is dropped, not printed under the badge.
    expect(feed).toContain("{body}")
    expect(feed).not.toContain("{msg.content}</p>")
  })
})
