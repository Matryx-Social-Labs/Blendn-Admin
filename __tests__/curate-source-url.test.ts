/**
 * A curated event's source is a web address (step 18 security review, L7).
 * It is rendered as a link on the public claim page, and `z.url()` alone took
 * `javascript:` and `data:` as URLs.
 */
const mockCreate = jest.fn()
jest.mock("@/lib/current-user", () => ({ requireAdmin: jest.fn().mockResolvedValue({ id: "admin", role: "app_admin" }) }))
jest.mock("@/lib/db", () => ({ db: { events: { create: (...a: unknown[]) => mockCreate(...a) }, $transaction: jest.fn() } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { curateEvent, type CurateInput } from "@/app/dashboard/events/curate/actions"

const input = (source_url: string): CurateInput => ({
  title: "Open Air Cinema",
  latitude: 12.97,
  longitude: 77.6,
  venue_name: "Cubbon Park",
  address: null,
  city: "Bengaluru",
  start_time: new Date(Date.now() + 86_400_000).toISOString(),
  end_time: new Date(Date.now() + 90_000_000).toISOString(),
  timezone: "Asia/Kolkata",
  source_url,
})

it.each(["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "ftp://example.com/listing"])(
  "refuses %s as a source, and creates nothing",
  async (url) => {
    const result = await curateEvent(input(url))
    expect(result).toEqual({ ok: false, error: "The source must be a web address (http or https)." })
    expect(mockCreate).not.toHaveBeenCalled()
  }
)
