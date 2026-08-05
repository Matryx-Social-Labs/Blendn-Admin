import {
  onboardingVerifyEmail,
  inviteEmail,
  approvedEmail,
  declinedEmail,
  domainVerifyEmail,
} from "@/lib/email"

/**
 * The five transactional templates.
 *
 * Copy is the one thing here nobody notices regressing — a template is only
 * read by the person it was sent to, months after whoever wrote it moved on.
 * So the two properties that matter are asserted rather than eyeballed.
 */

const templates = () => [
  onboardingVerifyEmail("Asha", "https://api.blendn.app/apply/verify?token=t"),
  inviteEmail("Byg Brewski", "Asha", "https://api.blendn.app/invite?token=t"),
  approvedEmail("Asha", "Byg Brewski", "asha@bygbrewski.com", "hunter2"),
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
  it("carries the credentials and tells them to change the password", () => {
    const t = approvedEmail("Asha", "Byg Brewski", "asha@bygbrewski.com", "hunter2")
    expect(t.text).toContain("asha@bygbrewski.com")
    expect(t.text).toContain("hunter2")
    expect(t.text).toMatch(/change the password/i)
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
