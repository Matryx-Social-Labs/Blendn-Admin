import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// The panel's server actions reach auth and the database; the row needs neither.
jest.mock("@/lib/sponsor-actions", () => ({ getEventSponsors: jest.fn() }))
jest.mock("@/components/poll-composer", () => ({ PollComposer: () => null }))
jest.mock("@/components/creative-media", () => ({
  CreativeMedia: () => "creative-attach",
}))

import { SponsoredMessageRow } from "@/components/event-messaging"

/*
 * A sponsored campaign offers only what this person may do (SCRUM-308).
 *
 * Driven on staging (organizer@, Nightshift Collective, may_sponsor off): the
 * Sponsored tab offered Add, Edit, the on/off switch and "Attach an image", and
 * every one answered "Forbidden" — they are gated on the sponsoring grant. Only
 * Delete (canEdit) was theirs.
 */
const msg = {
  id: "m1",
  content: "Cold brew on the house till 9",
  interval_minutes: 20,
  is_active: true,
  moderation_status: "approved",
  last_sent_at: null,
  deactivated_reason: null,
  media_url: null,
} as unknown as Parameters<typeof SponsoredMessageRow>[0]["msg"]
const noop = () => {}
const row = (mayAuthor: boolean, over: Partial<typeof msg> = {}) =>
  renderToStaticMarkup(
    createElement(SponsoredMessageRow, {
      eventId: "e1",
      msg: { ...msg, ...over },
      mayAuthor,
      onToggle: noop,
      onEdit: noop,
      onDelete: noop,
      onAttached: noop,
    })
  )

it("offers an author the switch, edit, creative and delete", () => {
  const html = row(true)
  expect(html).toMatch(/role="switch"/)
  expect(html).toMatch(/aria-label="Edit message"/)
  expect(html).toMatch(/creative-attach/)
  expect(html).toMatch(/aria-label="Delete message"/)
})

it("offers anyone else only delete, and says running or stopped in words where the switch was", () => {
  const running = row(false)
  expect(running).not.toMatch(/role="switch"/)
  expect(running).not.toMatch(/aria-label="Edit message"/)
  expect(running).not.toMatch(/creative-attach/)
  expect(running).toMatch(/aria-label="Delete message"/)
  expect(running).toMatch(/Running/)
  expect(row(false, { is_active: false })).toMatch(/Stopped/)
})
