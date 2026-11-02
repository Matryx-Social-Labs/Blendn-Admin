jest.mock("@/lib/env", () => ({ razorpayKeys: () => ({ keyId: "rzp_test_unit", keySecret: "unit_test_secret_0123" }) }))

import {
  createTicketOrder,
  createTransfer,
  orderPayments,
  paymentRefunds,
  paymentTransfers,
  refundPayment,
  reverseTransfer,
} from "@/lib/razorpay"

/**
 * The ticketing calls to Razorpay (SCRUM-1011): orders, refunds, and Route
 * transfers. No test keys exist on this machine, so Razorpay is a mocked HTTP
 * client here: these tests pin the request each call sends (method, path,
 * body) and that the answer is parsed before it is believed. The shapes are
 * Razorpay's documented ones (Orders, Refunds, Route transfers/reversals).
 */

type Sent = { url: string; method: string; body: unknown; auth: string | null }

function answer(json: unknown, status = 200): Sent[] {
  const sent: Sent[] = []
  jest.spyOn(global, "fetch").mockImplementation(async (url, init) => {
    const headers = new Headers(init?.headers)
    sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") })
    return new Response(JSON.stringify(json), { status })
  })
  return sent
}

afterEach(() => jest.restoreAllMocks())

const ORDER_ID = "6f1c2b8e-4c1a-4f7e-9a3b-2d5e8f0a1b2c"

describe("createTicketOrder", () => {
  it("asks for exactly the amount and currency given, receipted with our order id", async () => {
    const sent = answer({ id: "order_T1", amount: 108_182, currency: "INR", status: "created" })
    const order = await createTicketOrder({ orderId: ORDER_ID, amountMinor: 108_182, currency: "INR" })
    expect(order.id).toBe("order_T1")
    expect(sent).toEqual([
      {
        url: "https://api.razorpay.com/v1/orders",
        method: "POST",
        body: { amount: 108_182, currency: "INR", receipt: ORDER_ID, notes: { ticket_order_id: ORDER_ID } },
        auth: `Basic ${Buffer.from("rzp_test_unit:unit_test_secret_0123").toString("base64")}`,
      },
    ])
  })

  it("refuses an answer for another amount: Razorpay's word is checked, not assumed", async () => {
    answer({ id: "order_T1", amount: 1, currency: "INR", status: "created" })
    await expect(createTicketOrder({ orderId: ORDER_ID, amountMinor: 108_182, currency: "INR" })).rejects.toThrow(/amount/)
  })
})

describe("orderPayments", () => {
  it("lists an order's payments", async () => {
    const sent = answer({ items: [{ id: "pay_1", order_id: "order_T1", amount: 500, currency: "INR", status: "captured", created_at: 1_790_000_000 }] })
    const payments = await orderPayments("order_T1")
    expect(sent[0]).toMatchObject({ url: "https://api.razorpay.com/v1/orders/order_T1/payments", method: "GET" })
    expect(payments).toEqual([{ id: "pay_1", order_id: "order_T1", amount: 500, currency: "INR", status: "captured", created_at: 1_790_000_000 }])
  })
})

describe("refundPayment", () => {
  it("refunds the amount given, at normal speed, receipted with our order id", async () => {
    const sent = answer({ id: "rfnd_1", payment_id: "pay_1", amount: 49_900, currency: "INR", status: "processed" })
    const refund = await refundPayment({ paymentId: "pay_1", amountMinor: 49_900, orderId: ORDER_ID })
    expect(refund).toMatchObject({ id: "rfnd_1", amount: 49_900 })
    expect(sent[0]).toMatchObject({
      url: "https://api.razorpay.com/v1/payments/pay_1/refund",
      method: "POST",
      body: { amount: 49_900, speed: "normal", receipt: ORDER_ID, notes: { ticket_order_id: ORDER_ID } },
    })
  })

  it("lists a payment's refunds", async () => {
    const sent = answer({ items: [{ id: "rfnd_1", payment_id: "pay_1", amount: 100, currency: "INR", status: "processed" }] })
    expect(await paymentRefunds("pay_1")).toHaveLength(1)
    expect(sent[0]).toMatchObject({ url: "https://api.razorpay.com/v1/payments/pay_1/refunds", method: "GET" })
  })
})

describe("Route transfers", () => {
  it("transfers the share to the linked account, on hold until the given time", async () => {
    const until = new Date("2026-11-11T18:30:00Z")
    const sent = answer({ entity: "collection", count: 1, items: [{ id: "trf_1", recipient: "acc_ABCDEFGHIJKLMN", amount: 99_800, currency: "INR", on_hold: true }] })
    const transfer = await createTransfer({ paymentId: "pay_1", account: "acc_ABCDEFGHIJKLMN", amountMinor: 99_800, currency: "INR", onHoldUntil: until, orderId: ORDER_ID })
    expect(transfer.id).toBe("trf_1")
    expect(sent[0]).toMatchObject({
      url: "https://api.razorpay.com/v1/payments/pay_1/transfers",
      method: "POST",
      body: {
        transfers: [
          {
            account: "acc_ABCDEFGHIJKLMN",
            amount: 99_800,
            currency: "INR",
            on_hold: 1,
            on_hold_until: Math.floor(until.getTime() / 1000),
            notes: { ticket_order_id: ORDER_ID },
          },
        ],
      },
    })
  })

  it("refuses a transfer answer to another account", async () => {
    answer({ items: [{ id: "trf_1", recipient: "acc_SOMEONEELSE123", amount: 99_800, currency: "INR" }] })
    await expect(
      createTransfer({ paymentId: "pay_1", account: "acc_ABCDEFGHIJKLMN", amountMinor: 99_800, currency: "INR", onHoldUntil: new Date(), orderId: ORDER_ID })
    ).rejects.toThrow()
  })

  it("lists a payment's transfers", async () => {
    const sent = answer({ items: [{ id: "trf_1", recipient: "acc_ABCDEFGHIJKLMN", amount: 99_800, currency: "INR" }] })
    expect(await paymentTransfers("pay_1")).toEqual([{ id: "trf_1", recipient: "acc_ABCDEFGHIJKLMN", amount: 99_800, currency: "INR" }])
    expect(sent[0]).toMatchObject({ url: "https://api.razorpay.com/v1/payments/pay_1/transfers", method: "GET" })
  })

  it("reverses an amount of a transfer", async () => {
    const sent = answer({ id: "rvrsl_1", transfer_id: "trf_1", amount: 99_800, currency: "INR" })
    expect((await reverseTransfer("trf_1", 99_800)).id).toBe("rvrsl_1")
    expect(sent[0]).toMatchObject({ url: "https://api.razorpay.com/v1/transfers/trf_1/reversals", method: "POST", body: { amount: 99_800 } })
  })
})

it("never puts an id into a path unescaped", async () => {
  const sent = answer({ items: [] })
  await orderPayments("order_x/../../payments")
  expect(sent[0].url).toBe("https://api.razorpay.com/v1/orders/order_x%2F..%2F..%2Fpayments/payments")
})
