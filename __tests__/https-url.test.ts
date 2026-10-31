import { httpsUrl } from "@/lib/https-url"
import { eventFormSchema } from "@/components/event-form/schema"
import { eventWriteSchema } from "@/lib/validations/event"
import { updateProfileSchema } from "@/lib/validations/profile"

/*
 * SCRUM-956. `z.string().url()` takes `javascript:` and `data:` (anything the
 * WHATWG parser reads), and a link the platform stores is a link somebody opens:
 * a brand's website and logo, an event's link and cover, claim evidence. One
 * validator for all of them, https only.
 */
describe("httpsUrl", () => {
  const schema = httpsUrl()

  it.each(["https://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM", "  https://example.com  "])(
    "accepts %j",
    (u) => expect(schema.safeParse(u).success).toBe(true)
  )

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com",
    "ftp://example.com",
    "mailto:a@b.co",
    "//example.com",
    "example.com",
    "https://",
    "",
  ])("refuses %j", (u) => expect(schema.safeParse(u).success).toBe(false))

  it("trims before it checks, and stores the trimmed value", () => {
    expect(schema.parse("  https://example.com  ")).toBe("https://example.com")
  })

  it("keeps its length cap", () => {
    expect(httpsUrl(30).safeParse("https://example.com/" + "a".repeat(30)).success).toBe(false)
  })

  it("says what is wanted", () => {
    const r = schema.safeParse("http://example.com")
    expect(!r.success && r.error.issues[0]?.message).toMatch(/https/)
  })
})

describe("every stored link goes through it", () => {
  it("event link and cover", () => {
    expect(eventWriteSchema.shape.external_link.safeParse("javascript:alert(1)").success).toBe(false)
    expect(eventWriteSchema.shape.external_link.safeParse("http://example.com").success).toBe(false)
    expect(eventWriteSchema.shape.external_link.safeParse("https://example.com").success).toBe(true)
    expect(eventWriteSchema.shape.cover_image_url.safeParse("data:image/png;base64,AAAA").success).toBe(false)
    expect(eventWriteSchema.shape.cover_image_url.safeParse("https://example.com/c.png").success).toBe(true)
  })

  it("profile photos and the blur copy", () => {
    expect(updateProfileSchema.shape.photos.safeParse(["javascript:alert(1)"]).success).toBe(false)
    expect(updateProfileSchema.shape.photos.safeParse(["https://example.com/p.jpg"]).success).toBe(true)
    expect(updateProfileSchema.shape.blur_photo.safeParse("http://example.com/b.jpg").success).toBe(false)
  })
})

describe("an event's media items (the route reads item.url and item.thumbnail_url as strings)", () => {
  const item = { type: "image", url: "https://example.com/a.png", thumbnail_url: "https://example.com/t.png", title: "A", description: "B" }
  const media = (...items: unknown[]) => eventWriteSchema.shape.media_items.safeParse(items).success
  const form = (...items: unknown[]) => eventFormSchema.shape.media_items.safeParse(items).success

  it("takes a well-formed item, with an empty or missing thumbnail", () => {
    expect(media(item)).toBe(true)
    expect(media({ ...item, thumbnail_url: "" })).toBe(true)
    expect(media({ type: "video", url: "https://example.com/v.mp4" })).toBe(true)
  })

  it.each([
    ["url", { url: "javascript:alert(1)" }],
    ["url (http)", { url: "http://example.com/a.png" }],
    ["thumbnail", { thumbnail_url: "data:image/png;base64,AAAA" }],
    ["type", { type: "script" }],
    ["title length", { title: "x".repeat(201) }],
    ["description length", { description: "x".repeat(2001) }],
    ["url that is not a string", { url: { toString: "x" } }],
  ])("refuses a bad %s, on the server and in the form", (_label, bad) => {
    expect(media({ ...item, ...bad })).toBe(false)
    expect(form({ ...item, id: "i1", ...bad })).toBe(false)
  })

  it("holds the list to 50 and drops keys it does not know", () => {
    expect(media(...Array.from({ length: 51 }, () => item))).toBe(false)
    const parsed = eventWriteSchema.shape.media_items.parse([{ ...item, evil: "x" }])
    expect(parsed?.[0]).not.toHaveProperty("evil")
  })

  it("keeps the order the editor sends", () => {
    expect(eventWriteSchema.shape.media_items.parse([{ ...item, order: 3 }])?.[0]?.order).toBe(3)
  })
})

it("rejects userinfo in a link a person will be shown", () => {
  expect(httpsUrl().safeParse("https://good.example@evil.example/").success).toBe(false)
  expect(httpsUrl().safeParse("https://example.com/path@x").success).toBe(true)
})
