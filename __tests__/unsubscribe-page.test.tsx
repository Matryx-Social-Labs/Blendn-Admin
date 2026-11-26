import { renderToStaticMarkup } from "react-dom/server"

/*
 * The unsubscribe confirm page (SCRUM-1282): the button only for a token that is ours, its form POSTs the same token
 * back with `from=page`, and opening it writes nothing (it only reads `unsubscribeTarget`).
 */
const unsubscribeTarget = jest.fn()
const unsubscribe = jest.fn()
jest.mock("@/lib/unsubscribe", () => ({ unsubscribeTarget: (t: unknown) => unsubscribeTarget(t), unsubscribe: (t: unknown) => unsubscribe(t) }))

import UnsubscribePage from "@/app/unsubscribe/page"

const render = async (params: Record<string, string | string[] | undefined>) =>
  renderToStaticMarkup(await UnsubscribePage({ searchParams: Promise.resolve(params) }))

beforeEach(() => jest.clearAllMocks())

it("a token that is ours: one button, posting the same token back with from=page, and nothing written", async () => {
  unsubscribeTarget.mockResolvedValue("owner@blendn.app")
  const html = await render({ t: "u1.ab+c/d" })
  expect(html).toContain("Stop these emails?")
  expect(html).toContain('action="/api/email/unsubscribe?t=u1.ab%2Bc%2Fd&amp;from=page"')
  expect(html.match(/<button/g)).toHaveLength(1)
  expect(html).not.toContain("owner@blendn.app")
  expect(unsubscribe).not.toHaveBeenCalled()
})

it("a token that is not ours, a missing one, or two: no button", async () => {
  unsubscribeTarget.mockResolvedValue(null)
  for (const params of [{ t: "u1.bad" }, {}, { t: ["a", "b"] }]) {
    const html = await render(params)
    expect(html).toContain("This link doesn’t work")
    expect(html).not.toContain("<form")
  }
})

it("done: says so, and never reads the token", async () => {
  const html = await render({ done: "1" })
  expect(html).toContain("You’re unsubscribed")
  expect(unsubscribeTarget).not.toHaveBeenCalled()
})
