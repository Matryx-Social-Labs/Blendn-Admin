jest.mock("@/lib/env", () => ({ razorpayKeys: () => ({ keyId: "rzp_test_unit", keySecret: "unit_test_secret_0123" }) }))

import { RazorpayError, paymentLinkStatus } from "@/lib/razorpay"

/*
 * SCRUM-607: Razorpay's edge answers a source IP it blocks with 406, an empty
 * body and `server: awselb/2.0`. That has to read as "our IP", not as a
 * Razorpay outage, or the next one costs an afternoon again.
 */
const answer = (status: number, body: string, server = "awselb/2.0") =>
  jest.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status, headers: { server } }))

const failure = async () => {
  try {
    await paymentLinkStatus("plink_unit")
  } catch (err) {
    return err as RazorpayError
  }
  throw new Error("expected a RazorpayError")
}

afterEach(() => jest.restoreAllMocks())

describe("a Razorpay call that fails", () => {
  it("names the IP refusal when the edge answers 406 with an empty body", async () => {
    answer(406, "")
    const err = await failure()
    expect(err).toBeInstanceOf(RazorpayError)
    expect(err.status).toBe(406)
    expect(err.message).toMatch(/refused this server's IP/)
    expect(err.message).toContain("awselb/2.0")
  })

  it("keeps Razorpay's own sentence when a 406 carries one", async () => {
    answer(406, JSON.stringify({ error: { description: "Not acceptable for this account" } }))
    expect((await failure()).message).toBe("Not acceptable for this account")
  })

  it("says only the status for any other empty failure", async () => {
    answer(500, "")
    expect((await failure()).message).toBe("Razorpay answered 500")
  })
})
