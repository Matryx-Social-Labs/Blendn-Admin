import {
  onboardingVerifyEmail,
  inviteEmail,
  approvedEmail,
  declinedEmail,
  domainVerifyEmail,
  passwordResetEmail,
  applyUrl,
} from "@/lib/email"

/**
 * The transactional templates.
 *
 * Copy is the one thing here nobody notices regressing — a template is only
 * read by the person it was sent to, months after whoever wrote it moved on.
 * So the two properties that matter are asserted rather than eyeballed.
 */

const templates = () => [
  onboardingVerifyEmail("Asha", "https://api.blendn.app/apply/verify?token=t"),
  inviteEmail("Byg Brewski", "Asha", "https://api.blendn.app/invite?token=t"),
  approvedEmail("Asha", "Byg Brewski", "asha@bygbrewski.com", "https://x/reset-password?token=t"),
  declinedEmail("Asha", "We couldn't confirm your venue licence."),
  domainVerifyEmail("bygbrewski.com", "https://api.blendn.app/verify?token=t"),
  passwordResetEmail("Asha", "https://api.blendn.app/reset-password?token=t"),
]

/** The two that follow the Claude Design templates; the rest use the older shell. */
const designed = () => [
  onboardingVerifyEmail("Asha", "https://api.blendn.app/apply/verify?token=t"),
  passwordResetEmail("Asha", "https://api.blendn.app/reset-password?token=t"),
]
const shelled = () => [
  inviteEmail("Byg Brewski", "Asha", "https://api.blendn.app/invite?token=t"),
  approvedEmail("Asha", "Byg Brewski", "asha@bygbrewski.com", "https://x/reset-password?token=t"),
  declinedEmail("Asha", "We couldn't confirm your venue licence."),
  domainVerifyEmail("bygbrewski.com", "https://api.blendn.app/verify?token=t"),
]

describe("the brand is spelled Blend'n", () => {
  it("never writes it without the apostrophe", () => {
    // The UI has always written `Blend'n`; the email copy was the one place
    // that said "Blendn", so the sender name and the body disagreed.
    for (const t of templates()) {
      const body = `${t.subject}\n${t.text}`
      // Match the bare word only — blendn.app in a URL is correct and must not
      // trip this.
      expect(body).not.toMatch(/\bBlendn\b/)
    }
  })
})

describe("every template carries its link and says how long it lasts", () => {
  it("includes the link it was given", () => {
    const withLinks = [
      onboardingVerifyEmail("Asha", "https://example.test/a"),
      inviteEmail("Org", "Asha", "https://example.test/b"),
      domainVerifyEmail("acme.com", "https://example.test/c"),
    ]
    for (const [i, t] of withLinks.entries()) {
      expect(t.text).toContain(`https://example.test/${"abc"[i]}`)
    }
  })

  it("tells the recipient when the link expires", () => {
    // A link that silently stops working, with no stated lifetime, generates a
    // support ticket every time.
    expect(onboardingVerifyEmail("A", "l").text).toMatch(/expires in 24 hours/)
    expect(inviteEmail("O", "A", "l").text).toMatch(/expires in 7 days/)
    expect(domainVerifyEmail("acme.com", "l").text).toMatch(/expires in 24 hours/)
  })

  it("tells someone who didn't expect it that they can ignore it", () => {
    // These three arrive unsolicited from the recipient's point of view.
    for (const t of [
      onboardingVerifyEmail("A", "l"),
      inviteEmail("O", "A", "l"),
      domainVerifyEmail("acme.com", "l"),
    ]) {
      expect(t.text).toMatch(/ignore/i)
    }
  })
})

describe("the approval email", () => {
  it("carries the address and a set-password link, and never a password (SCRUM-134)", () => {
    const link = "https://api.blendn.app/reset-password?token=abc"
    const t = approvedEmail("Asha", "Byg Brewski", "asha@bygbrewski.com", link)
    expect(t.text).toContain("asha@bygbrewski.com")
    expect(t.text).toContain(link)
    expect(t.text).toMatch(/expires in 24 hours/i)
    expect(t.text).not.toMatch(/^Password:/m)
  })

  it("tells a promoted account to use the password it already has", () => {
    const t = approvedEmail("Asha", "Byg Brewski", "asha@bygbrewski.com", null)
    expect(t.text).toMatch(/existing password/i)
    expect(t.text).not.toContain("reset-password")
  })
})

describe("the decline email", () => {
  it("carries the reason and invites a reply", () => {
    // The reason is the whole point — a decline with no cause gets an identical
    // reapplication. And the reply invitation is why the sender address must be
    // a monitored mailbox rather than no-reply@.
    const t = declinedEmail("Asha", "We couldn't confirm your venue licence.")
    expect(t.text).toContain("We couldn't confirm your venue licence.")
    expect(t.text).toMatch(/reply to this email/i)
  })
})

/* -------------------------------------------------------------------------- */
/* The HTML halves                                                             */
/* -------------------------------------------------------------------------- */

describe("every email ships both parts", () => {
  it("has html alongside text", () => {
    // Multipart, not one or the other. An HTML-only email scores worse with
    // spam filters, and the text part is what a text-only client and a screen
    // reader in plain mode actually get.
    for (const t of templates()) {
      expect(typeof t.text).toBe("string")
      expect(typeof (t as { html?: string }).html).toBe("string")
      expect((t as { html: string }).html.length).toBeGreaterThan(400)
    }
  })
})

describe("the HTML survives the clients that break HTML", () => {
  const htmls = () => templates().map((t) => (t as { html: string }).html)

  it("uses table layout, never flex or grid", () => {
    // Outlook renders with Word. Flexbox and grid do not exist there.
    for (const html of htmls()) {
      expect(html).toContain("<table")
      expect(html).not.toMatch(/display\s*:\s*(flex|grid)/)
    }
  })

  it("keeps every colour and font inline, except the dark-mode query", () => {
    for (const html of htmls()) {
      // One <style> block only, and it is the media query.
      expect(html.match(/<style>/g)?.length).toBe(1)
      expect(html).toMatch(/prefers-color-scheme:\s?dark/)
      expect(html).toContain('style="')
    }
  })

  it("caps the body at 600px", () => {
    for (const html of htmls()) {
      expect(html).toContain('width="600"')
      expect(html).toContain("max-width:100%")
    }
  })

  it("declares support for both colour schemes", () => {
    for (const html of htmls()) {
      expect(html).toContain('name="color-scheme" content="light dark"')
    }
  })
})

describe("the HTML is readable with images blocked", () => {
  it("renders the wordmark as live text, not only as an image", () => {
    // A large share of recipients have images off by default. A logo-only
    // header leaves them with an unbranded email.
    for (const html of shelled().map((t) => (t as { html: string }).html)) {
      expect(html).toContain("Blend&#39;n</span>")
    }
  })

  it("gives the decorative monogram an empty alt", () => {
    // It carries no information the text does not; alt text would be noise for
    // a screen reader.
    for (const html of shelled().map((t) => (t as { html: string }).html)) {
      expect(html).toContain('alt=""')
    }
  })

  it("names the brand in the lockup's alt text where the logo is the wordmark", () => {
    // The design's header is the lockup image alone; with images off, the alt
    // text is what the client shows in its place.
    for (const html of designed().map((t) => t.html)) {
      const imgs = html.match(/<img [^>]*>/g) ?? []
      expect(imgs.length).toBe(2) // light and dark lockups
      for (const img of imgs) expect(img).toContain(`alt="Blend'n"`)
    }
  })
})

describe("links work when the client strips the button", () => {
  it("prints the raw URL under every call to action", () => {
    const withLinks = [
      onboardingVerifyEmail("Asha", "https://example.test/verify-me", "Org"),
      inviteEmail("Org", "Asha", "https://example.test/invite-me"),
      domainVerifyEmail("acme.com", "https://example.test/domain-me"),
    ]
    for (const t of withLinks) {
      const html = (t as unknown as { html: string }).html
      // Once in the button href, once as visible fallback text.
      expect(html).toContain("Paste this into your browser")
      const url = html.match(/https:\/\/example\.test\/[a-z-]+/g) ?? []
      expect(url.length).toBeGreaterThanOrEqual(2)
    }
  })

  it("wraps the button in a table cell carrying the background", () => {
    // A styled <a> alone renders as a bare blue link in Outlook.
    const html = (inviteEmail("Org", "Asha", "l") as unknown as { html: string }).html
    expect(html).toMatch(/<td bgcolor="#F05423"/)
  })
})

describe("HTML escaping", () => {
  it("escapes an organisation name containing markup", () => {
    // Org display names are user-supplied at /apply.
    const html = (
      approvedEmail("A", '<script>alert(1)</script>', "a@b.com", null) as unknown as { html: string }
    ).html
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("escapes an apostrophe in a name without mangling it", () => {
    const html = (
      declinedEmail("O'Brien", "Reason enough to explain.") as unknown as { html: string }
    ).html
    expect(html).toContain("O&#39;Brien")
  })

  it("escapes the decline reason, which is typed by an admin", () => {
    const html = (
      declinedEmail("A", '"><img src=x onerror=alert(1)>') as unknown as { html: string }
    ).html
    expect(html).not.toContain("<img src=x")
  })
})

describe("no invented compliance footer", () => {
  it("omits the address line when EMAIL_FOOTER_ADDRESS is unset", () => {
    // The design mocked up a registered office. Shipping a made-up address in a
    // compliance footer is worse than shipping none.
    delete process.env.EMAIL_FOOTER_ADDRESS
    const html = (declinedEmail("A", "Reason enough.") as unknown as { html: string }).html
    expect(html).not.toContain("Residency Road")
    expect(html).toContain("transactional email")
  })

  it("includes it when set", () => {
    process.env.EMAIL_FOOTER_ADDRESS = "Blend'n, 1 Test Road, Bengaluru"
    const html = (declinedEmail("A", "Reason enough.") as unknown as { html: string }).html
    expect(html).toContain("1 Test Road")
    delete process.env.EMAIL_FOOTER_ADDRESS
  })
})

describe("the approval email's account block", () => {
  it("carries the address and the set-password button, and no password", () => {
    const link = "https://api.blendn.app/reset-password?token=abc"
    const html = (approvedEmail("Asha", "Byg Brewski", "asha@byg.in", link) as unknown as { html: string }).html
    expect(html).toContain("asha@byg.in")
    expect(html).toContain(`href="${link}"`)
    expect(html).toMatch(/Set your password/)
    expect(html).not.toMatch(/>Password</)
  })
})

/* -------------------------------------------------------------------------- */
/* Which host each link points at                                              */
/* -------------------------------------------------------------------------- */

describe("host-facing links can move; session-bound links cannot", () => {
  const ORIGINAL = { ...process.env }
  afterEach(() => {
    process.env.NEXTAUTH_URL = ORIGINAL.NEXTAUTH_URL
    delete process.env.PUBLIC_APPLY_URL
  })

  it("applyUrl falls back to the dashboard when unset", () => {
    process.env.NEXTAUTH_URL = "https://api.blendn.app"
    delete process.env.PUBLIC_APPLY_URL
    expect(applyUrl()).toBe("https://api.blendn.app")
  })

  it("applyUrl follows PUBLIC_APPLY_URL when set", () => {
    process.env.PUBLIC_APPLY_URL = "https://organizers.blendn.app"
    expect(applyUrl()).toBe("https://organizers.blendn.app")
  })

  it("strips a trailing slash so links never double up", () => {
    // `https://x.app//apply/verify` is a 404 on most hosts.
    process.env.PUBLIC_APPLY_URL = "https://organizers.blendn.app/"
    expect(applyUrl()).toBe("https://organizers.blendn.app")
  })

  it("ignores a blank value rather than emitting a relative link", () => {
    process.env.PUBLIC_APPLY_URL = "   "
    process.env.NEXTAUTH_URL = "https://api.blendn.app"
    expect(applyUrl()).toBe("https://api.blendn.app")
  })

  it("keeps the sign-in link on the dashboard even when apply has moved", () => {
    // The approval email hands over a password for a dashboard that lives on
    // NEXTAUTH_URL. Sending someone to the marketing host to sign in would be a
    // 404 at the exact moment they first try to use the product.
    process.env.NEXTAUTH_URL = "https://api.blendn.app"
    process.env.PUBLIC_APPLY_URL = "https://organizers.blendn.app"
    const t = approvedEmail("Asha", "Byg Brewski", "a@byg.in", null)
    expect(t.text).toContain("https://api.blendn.app/login")
    expect(t.text).not.toContain("organizers.blendn.app")
  })
})

/* -------------------------------------------------------------------------- */
/* The design's account emails: confirm and reset                              */
/* -------------------------------------------------------------------------- */

describe("the confirm and reset emails, from the design", () => {
  const confirmLink = "https://organizers.blendn.app/apply/verify?token=tok_123"
  const resetLink = "https://api.blendn.app/reset-password?token=abc&next=%2Flogin"
  const confirm = () => onboardingVerifyEmail("Asha", confirmLink, "Byg Brewski")
  const reset = () => passwordResetEmail("Asha", resetLink)

  it("keeps the subjects the code has always sent", () => {
    expect(confirm().subject).toBe("Confirm your email — Blend'n host application")
    expect(reset().subject).toBe("Reset your Blend'n password")
  })

  it("puts the confirm link in the button and prints it under it", () => {
    const html = confirm().html
    expect(html.match(new RegExp(`href="${confirmLink.replace(/[.?]/g, "\\$&")}"`, "g"))?.length).toBe(2)
    expect(html).toContain(`>${confirmLink}</a>`)
    expect(confirm().text).toContain(confirmLink)
  })

  it("puts the reset link in the button, escaped for HTML", () => {
    // `&` in a query string is `&amp;` inside an attribute; a raw one is
    // invalid HTML that some clients truncate at.
    const html = reset().html
    const escaped = resetLink.replace(/&/g, "&amp;")
    expect(html.split(`href="${escaped}"`).length - 1).toBe(2)
    expect(html).not.toContain(`href="${resetLink}"`)
    expect(reset().text).toContain(resetLink)
  })

  it("states the expiry the code enforces, not the design's", () => {
    // Onboarding tokens live 24 hours (app/api/onboarding/apply). Reset links
    // live one hour (RESET_TTL_MS); the design said 30 minutes.
    expect(confirm().html).toContain("The link works for 24 hours.")
    expect(confirm().text).toMatch(/expires in 24 hours/)
    expect(reset().html).toContain("The link works for one hour and only once.")
    expect(reset().html).toContain("The link works for one hour.") // preheader
    expect(reset().html).not.toMatch(/30 minutes/)
    expect(reset().text).toMatch(/expires in one hour/)
  })

  it("carries the recipient's name, and the organisation they applied as", () => {
    expect(confirm().html).toContain("Hi Asha,")
    expect(confirm().html).toContain("<b>Byg Brewski</b>")
    expect(reset().html).toContain("Hi Asha,")
  })

  it("names the brand and the company as the guidelines spell them", () => {
    for (const { html } of [confirm(), reset()]) {
      expect(html).toContain("Blend'n")
      expect(html).not.toMatch(/\bBlendn\b/)
      expect(html).toContain("Matrix Social Labs")
      expect(html).not.toContain("Matryx") // the registered name is for legal lines only
    }
  })

  it("leaves no placeholder unfilled", () => {
    for (const { html } of [confirm(), reset()]) {
      expect(html).not.toMatch(/REPLACE_TOKEN|\{\{|\}\}|\$\{|undefined|>null<|\.\.\/assets/)
    }
  })

  it("loads its logos from absolute https URLs on www.blendn.app", () => {
    for (const { html } of [confirm(), reset()]) {
      const srcs = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1])
      expect(srcs).toEqual([
        "https://www.blendn.app/brand/lockup-dark.png",
        "https://www.blendn.app/brand/lockup-white.png",
      ])
    }
  })

  it("puts ink text on the orange button, never white", () => {
    // White on #F97316 is 2.8:1 and fails AA; ink is 7.6:1.
    const html = reset().html
    expect(html).toMatch(/<td class="btn" bgcolor="#F97316"/)
    expect(html).toMatch(/<a href="[^"]+" style="[^"]*color:#0D0C0C[^"]*">Reset password<\/a>/)
  })

  it("uses no emoji", () => {
    for (const { html } of [confirm(), reset()]) {
      expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|&#(9202|128274);/u)
    }
  })

  it("escapes a name or organisation containing markup", () => {
    // Both are typed by the applicant at /apply.
    const html = onboardingVerifyEmail("<i>A</i>", "l", '<script>alert(1)</script>').html
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<i>A</i>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("prints the configured footer address, and none when unset", () => {
    delete process.env.EMAIL_FOOTER_ADDRESS
    expect(reset().html).toContain("nothing to unsubscribe from")
    expect(reset().html).not.toContain("1 Test Road")
    process.env.EMAIL_FOOTER_ADDRESS = "Blend'n, 1 Test Road, Bengaluru"
    expect(reset().html).toContain("1 Test Road")
    delete process.env.EMAIL_FOOTER_ADDRESS
  })
})
