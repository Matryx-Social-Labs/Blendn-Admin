import { renderToStaticMarkup } from "react-dom/server"

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/app/dashboard/moderation/reports/actions", () => ({ resolveReport: jest.fn() }))

import type { ReportRow } from "@/app/dashboard/moderation/reports/actions"
import { ReportsTable } from "@/app/dashboard/moderation/reports/reports-table"

/*
 * How a board report reads in the admin queue (SCRUM-322): the post's kind,
 * the ask, the words, how many people reported it, and Remove only where there
 * is something a moderator can still take down.
 */

const row = (id: string, over: Partial<ReportRow>): ReportRow => ({
  id,
  kind: "message",
  ageHours: 3,
  reason: "harassment",
  description: null,
  reporterName: "Reporter",
  subjectId: "author",
  subjectName: "Author",
  subjectSuspended: false,
  excerpt: "two seats, insta first",
  messageType: "board_post",
  boardKind: "offer",
  messageDeleted: false,
  gone: false,
  removable: true,
  sameSubject: 1,
  eventTitle: "Techno Tuesday",
  eventId: "e1",
  room: false,
  reviewedBy: null,
  ...over,
})

const render = (rows: ReportRow[]) => renderToStaticMarkup(<ReportsTable rows={rows} status="pending" />)
const removeButtons = (html: string) => (html.match(/>Remove post</g) ?? []).length

it("names a board post by its kind, and an ask as an ask", () => {
  const html = render([
    row("a", { boardKind: "offer" }),
    row("b", { boardKind: "seeking" }),
    row("c", { boardKind: "chat" }),
    row("d", { messageType: "board_request", boardKind: null, removable: false, excerpt: "can i come?" }),
  ])
  for (const label of ["Board · offer", "Board · seeking", "Board · chat", "Board ask"]) expect(html).toContain(label)
  expect(html).toContain("can i come?")
})

it("offers Remove post only on a board post that a moderator can still take down", () => {
  expect(removeButtons(render([row("a", {})]))).toBe(1)
  // Withdrawn by its author but not yet marked: still removable, and says so.
  const withdrawn = render([row("a", { messageDeleted: true, removable: true })])
  expect(removeButtons(withdrawn)).toBe(1)
  expect(withdrawn).toContain("(removed)")
  expect(removeButtons(render([row("a", { messageDeleted: true, removable: false })]))).toBe(0)
  expect(removeButtons(render([row("a", { gone: true, removable: false, excerpt: null, subjectId: null })]))).toBe(0)
  expect(removeButtons(render([row("d", { messageType: "board_request", removable: false })]))).toBe(0)
})

it("tells an erased ask from one that never had a message", () => {
  expect(render([row("d", { messageType: "board_request", removable: false, excerpt: null })])).toContain(
    "asked without a message"
  )
  const erased = render([row("d", { messageType: "board_request", removable: false, excerpt: null, gone: true })])
  expect(erased).toContain("no longer exists")
  expect(erased).not.toContain("asked without a message")
})

it("says how many people reported the same thing", () => {
  expect(render([row("a", { sameSubject: 3 })])).toContain("3 reports")
  expect(render([row("a", { sameSubject: 1 })])).not.toContain("1 reports")
})
