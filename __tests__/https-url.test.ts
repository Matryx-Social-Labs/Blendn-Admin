import { httpsUrl } from "@/lib/https-url"
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
