import { renderToStaticMarkup } from "react-dom/server"
import { OpenTheApp } from "@/components/open-the-app"
import { appLinksFor, audienceOf } from "@/lib/app-links"

describe("the reset-password 'done' for an attendee (SV15)", () => {
  afterEach(() => {
    delete process.env.APP_STORE_LISTED
    delete process.env.PLAY_LISTED
  })

  it("opens the app by its scheme, with no sign-in link", () => {
    const html = renderToStaticMarkup(<OpenTheApp app={appLinksFor("attendee")} />)
    expect(html).toContain('href="blendn://"')
    expect(html).toContain("Open Blend&#x27;n")
    expect(html).not.toContain("/login")
    // Listings not public yet: no dead store links.
    expect(html).not.toContain("apps.apple.com")
    expect(html).not.toContain("play.google.com")
  })

  it("offers the store listings as the fallback once they are public", () => {
    process.env.APP_STORE_LISTED = "true"
    process.env.PLAY_LISTED = "true"
    const html = renderToStaticMarkup(<OpenTheApp app={appLinksFor("attendee")} />)
    expect(html).toContain("https://apps.apple.com/app/id6757761059")
    expect(html).toContain("https://play.google.com/store/apps/details?id=com.matryxsociallabs.blendn")
  })

  it("is for attendees only: the dashboard roles get no app links, and keep /login", () => {
    expect(audienceOf("attendee")).toBe("attendee")
    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"] as const) {
      expect(audienceOf(role)).toBe("dashboard")
    }
    expect(appLinksFor("dashboard")).toBeNull()
  })
})
