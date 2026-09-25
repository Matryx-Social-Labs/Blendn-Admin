import { readFileSync } from "fs"
import { join } from "path"
import { NextResponse } from "next/server"
import { errorResponse } from "@/lib/api-response"
import { refusalText } from "@/lib/refusal"

/*
 * A refused save says why (SCRUM-315).
 *
 * Driven on staging: capacity 0 on an event's edit page → PATCH 400
 * "max_capacity must be a positive integer" → the toast said "Failed to save
 * event". Every refusal the event routes write — no owning organisation,
 * capacity, a missing description — was thrown away at the same line, so an
 * organiser with no organisation filled in the whole form and was told
 * nothing (SCRUM-251). The editor pulls in Leaflet and cannot render under
 * node, so the wiring is read from the source; the reading is exercised for
 * real against both shapes the routes answer with.
 */
const FALLBACK = "Failed to save event"
const src = readFileSync(join(__dirname, "..", "components", "event-editor.tsx"), "utf8")

describe("the sentences the event routes refuse with", () => {
  it("reads the envelope PATCH /api/events/[id] sends", async () => {
    const res = errorResponse("max_capacity must be a positive integer", 400)
    expect(await refusalText(res, FALLBACK)).toBe("max_capacity must be a positive integer")
  })

  it("reads the bare { error } POST /api/events sends for a creator with no organisation", async () => {
    const res = NextResponse.json({ error: "You are not in an organisation yet" }, { status: 400 })
    expect(await refusalText(res, FALLBACK)).toBe("You are not in an organisation yet")
  })
})

describe("the event editor's save", () => {
  it("shows the server's sentence for a refused save, not one sentence for all of them", () => {
    const branch = src.indexOf("if (!response.ok) {")
    expect(branch).toBeGreaterThan(-1)
    const body = src.slice(branch, src.indexOf("}", branch) + 1)
    expect(body).toMatch(/toast\.error\(await refusalText\(response, "Failed to save event"\)\)/)
    expect(body).toMatch(/return/)
    // The old line, which turned every refusal into the fallback.
    expect(src).not.toMatch(/throw new Error\("Failed to save event"\)/)
  })
})
