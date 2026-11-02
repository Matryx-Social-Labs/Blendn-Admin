jest.mock("@/lib/db", () => ({ db: {} }))

import { externalSiteOf, refusalResponse } from "@/lib/ticket-views"

/** The mobile ticket routes' refusal answers (contract §2, §3, §8.1) and the external site label (§1). */

describe("refusalResponse", () => {
  it.each([
    ["sold_out", 409, "sold_out"],
    ["not_on_sale", 409, "not_on_sale"],
    ["private", 409, "private"],
    ["under_age", 409, "age"],
    ["unknown_ticket_type", 409, "unknown_ticket_type"],
    ["over_order_limit", 409, "over_order_limit"],
    ["too_many_seats", 409, "over_buyer_limit"],
    ["too_many_holds", 409, "too_many_holds"],
    ["free_order", 409, "not_on_sale"],
    ["fees_exceed_price", 409, "not_on_sale"],
    ["ticketing_off", 404, "NOT_FOUND"],
    ["bad_lines", 400, "VALIDATION_FAILED"],
  ] as const)("%s is %i %s, in errorCode", async (reason, status, code) => {
    const res = refusalResponse(reason)
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ success: false, errorCode: code })
  })

  it("busy says to retry after a second", async () => {
    const res = refusalResponse("busy")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: expect.any(String), errorCode: "busy", retryAfter: 1 })
  })
})

describe("externalSiteOf", () => {
  it.each([
    ["https://www.eventbrite.ca/e/1", "eventbrite.ca"],
    ["https://WWW.Showpass.com/x", "showpass.com"],
    ["https://lu.ma/abc", "lu.ma"],
    ["https://wwwhat.example/x", "wwwhat.example"],
    ["not a url", null],
  ])("%s → %s", (url, site) => expect(externalSiteOf(url)).toBe(site))
})
