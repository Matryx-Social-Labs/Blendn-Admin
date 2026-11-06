import { renderToStaticMarkup } from "react-dom/server"
import { createRef } from "react"

import { DoorVerdict } from "@/app/dashboard/events/[id]/door/door-client"

import { WORST } from "./support/long-text"

/*
 * The door's verdict (owner, 2026-11-05, naming pass SCRUM-1027): "Let in" alone is the headline, and the ticket type is
 * its own line under it, so a long type name never pushes the word staff read at a glance onto a second line.
 * Mockup: .context/mockups/door-verdict-let-in-20261106.html.
 */

jest.mock("@/app/dashboard/events/[id]/door/actions", () => ({ admitTicket: jest.fn() }))

const letIn = (typeName: string) =>
  renderToStaticMarkup(
    <DoorVerdict
      reply={{ kind: "let_in", code: "ABC234", typeName, nth: 1, of: 2, at: "2026-11-06T15:34:00.000Z", count: { inside: WORST.count, of: WORST.count } }}
      time={() => "21:04"}
      onNext={() => {}}
      nextRef={createRef<HTMLButtonElement>()}
    />
  )

const paragraphs = (html: string) => [...html.matchAll(/<p class="([^"]*)">([^<]*)<\/p>/g)].map((m) => ({ cls: m[1], text: m[2] }))

describe("the door's verdict", () => {
  it.each([WORST.ticketType, WORST.ticketTypeDevanagari, "General"])("%s: the headline is “Let in” alone, the type its own line under it", (type) => {
    const [big, typeLine, why] = paragraphs(letIn(type))
    expect(big.text).toBe("Let in")
    expect(typeLine.text).toBe(type.replace(/&/g, "&amp;"))
    expect(typeLine.cls).toContain("break-words")
    expect(why.text).toBe("Ticket 1 of 2 on this order · 21:04")
  })

  it("never glues the type onto the headline", () => {
    expect(letIn(WORST.ticketType)).not.toContain("Let in ·")
  })
})
