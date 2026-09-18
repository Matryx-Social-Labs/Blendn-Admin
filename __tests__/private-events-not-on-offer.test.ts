import { readFileSync } from "fs"
import { join } from "path"

import { eventFormSchema } from "@/components/event-form/schema"
import { homeOrgIdFor } from "@/lib/event-ownership"

import { stripComments } from "./support/strip-comments"

jest.mock("@/lib/db", () => ({ db: { organisation_members: { findFirst: jest.fn() } } }))
import { db } from "@/lib/db"

/**
 * Two decisions from the 2026-09-18 review, pinned.
 *
 * SCRUM-147: "Private" is not on offer. A private event could never gain an
 * attendee — every attendee route needs an RSVP to see it and RSVPing needs to
 * see it — and there is no invite to hand out. The column keeps the enum for
 * the rows that have it; the form and both write schemas refuse it with a
 * sentence that names the alternative.
 *
 * SCRUM-148: "my org" is one rule. Two venue pickers used to do their own
 * `findFirst` with no `orderBy`, so a person in two organisations landed on
 * whichever row Postgres returned. Every picker goes through `homeOrgIdFor`.
 */
const ROOT = join(__dirname, "..")
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

describe("private is not on offer (SCRUM-147)", () => {
  it("the form has Public and Unlisted, and no Private", () => {
    const src = code("components/event-form/capacity-settings-section.tsx")
    expect(src).toMatch(/SelectItem value="public"/)
    expect(src).toMatch(/SelectItem value="unlisted"/)
    expect(src).not.toMatch(/SelectItem value="private"/)
  })

  it("both write schemas refuse it with the sentence, and the editor opens a legacy row as unlisted", () => {
    const form = eventFormSchema.safeParse({ visibility: "private" })
    expect(form.success).toBe(false)
    expect(JSON.stringify(form.error?.issues)).toContain("Private events aren't available yet")
    expect(code("lib/validations/event.ts")).toMatch(/visibility: z\s*\.enum\(\["public", "unlisted"\]/)
    expect(code("components/event-editor.tsx")).toContain(`initialEvent.visibility === "private" ? "unlisted" : initialEvent.visibility`)
  })

  it("the door reads visibility through the same resolver as every other participation route", () => {
    const door = code("app/api/mobile/events/[eventId]/checkin/route.ts")
    expect(door).toMatch(/event\.visibility === "private" && !\(await canJoinEvent\(authUser\.userId, eventId\)\)/)
  })
})

describe("my org is one rule (SCRUM-148)", () => {
  it("is the oldest live membership, deterministically", async () => {
    ;(db.organisation_members.findFirst as jest.Mock).mockResolvedValue({ org_id: "org-oldest" })
    expect(await homeOrgIdFor({ id: "u1", role: "organizer" })).toBe("org-oldest")
    const call = (db.organisation_members.findFirst as jest.Mock).mock.calls[0][0]
    expect(call.orderBy).toEqual({ created_at: "asc" })
    expect(JSON.stringify(call.where)).toContain('"status":{"not":"suspended"}')
    expect(await homeOrgIdFor({ id: "admin", role: "app_admin" })).toBeNull()
  })

  it("every picker goes through it — no picker rolls its own findFirst", () => {
    for (const p of ["lib/venue-actions.ts", "lib/venue-claim-actions.ts", "lib/event-claim-actions.ts"]) {
      const src = code(p)
      expect(src).toMatch(/homeOrgIdFor\(|owningOrgFor\(/)
      // A user-keyed findFirst with no orderBy is the nondeterminism this fixes.
      expect(src).not.toMatch(/organisation_members\.findFirst\(\{\s*where: \{ user_id: user\.id, \.\.\.activeMembership \},\s*select/)
    }
  })
})
