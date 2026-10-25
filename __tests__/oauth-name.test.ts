import { OAUTH_NAME_MAX, oauthDisplayName } from "@/lib/moderation/oauth-name"

/*
 * A name from Sign in with Apple (sent by the app, unsigned) or Google, before
 * it lands on a card (PR #755 review, M2). Never a reason sign-in fails.
 */
it("keeps an ordinary name, whitespace collapsed", () => {
  expect(oauthDisplayName("  Asha   Rao ")).toBe("Asha Rao")
})

it("caps at 64 characters without cutting an emoji in half", () => {
  const long = "🙂".repeat(100)
  const capped = oauthDisplayName(long)!
  expect([...capped]).toHaveLength(OAUTH_NAME_MAX)
  expect(capped).toBe("🙂".repeat(64))
  expect(oauthDisplayName("a".repeat(500))).toHaveLength(64)
})

it("gives no name for an unambiguous slur, so onboarding asks for one", () => {
  expect(oauthDisplayName("Retard McGee")).toBeNull()
})

it("keeps a real name the chat list would hide", () => {
  expect(oauthDisplayName("Bal Krishna")).toBe("Bal Krishna")
  expect(oauthDisplayName("Shala Patel")).toBe("Shala Patel")
})

it("is null for nothing at all", () => {
  expect(oauthDisplayName(undefined)).toBeNull()
  expect(oauthDisplayName("   ")).toBeNull()
})
