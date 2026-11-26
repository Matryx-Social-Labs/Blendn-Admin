/**
 * SCRUM-1153: the header offers "Duplicate" to whoever may edit an ordinary
 * event, and to nobody else: not a venue owner who only operates it, not on a
 * venue day (whose canEdit is an app admin's).
 */
jest.mock("@/app/dashboard/events/[id]/venue-link", () => ({ EventVenueLink: () => null }))

import { renderToStaticMarkup } from "react-dom/server"

import { EventHeader } from "@/components/dashboard/event-header"
import type { EventPageData } from "@/lib/event-page"

const ID = "0f546e5a-de3f-44f9-a8d0-5896752ccda0"

function header(kind: "event" | "venue_day", permissions: { canEdit: boolean; canOperate: boolean }) {
  const event = {
    id: ID,
    title: "Thursday Supper Club",
    kind,
    status: "published",
    timezone: "America/Toronto",
    city: "Toronto",
    venue: null,
    venue_name: "The Drake Underground",
    start_time: new Date("2026-12-04T00:30:00Z"),
    end_time: new Date("2026-12-04T04:30:00Z"),
    created_at: new Date("2026-11-20T00:00:00Z"),
  } as unknown as EventPageData["event"]
  return renderToStaticMarkup(
    <EventHeader
      data={{ event, permissions: { ...permissions, canViewAttendees: permissions.canEdit } }}
      active="overview"
      now={new Date("2026-11-26T12:00:00Z")}
    />
  )
}

const DUPLICATE = `href="/dashboard/events/new?from=${ID}"`

it("shows Duplicate, after Edit event, to whoever may edit the event", () => {
  const html = header("event", { canEdit: true, canOperate: true })
  expect(html).toContain(DUPLICATE)
  expect(html).toContain(">Duplicate<")
  expect(html.indexOf("Edit event")).toBeLessThan(html.indexOf(DUPLICATE))
})

it("hides it from a venue owner who operates the night but may not edit it", () => {
  expect(header("event", { canEdit: false, canOperate: true })).not.toContain("events/new?from=")
})

it("hides it on a venue day, even from an app admin who may edit one", () => {
  expect(header("venue_day", { canEdit: true, canOperate: true })).not.toContain("events/new?from=")
})
