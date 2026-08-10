import { googleSignInConfigWarning } from "@/lib/env"

/**
 * The configuration that broke production, pinned.
 *
 * Only `GOOGLE_IOS_CLIENT_ID` was set. The native Google SDK audiences its id
 * token to the *web* client id, so `verifyGoogleIdToken` rejected every real
 * sign-in on `aud` while the health check stayed green and email sign-in kept
 * working. The whole point of this function is that that combination is never
 * intentional, so the middle case is the one that matters.
 */
describe("googleSignInConfigWarning", () => {
  const WEB = "111-web.apps.googleusercontent.com"
  const IOS = "111-ios.apps.googleusercontent.com"
  const ANDROID = "111-android.apps.googleusercontent.com"

  it("warns when a native client id is set without the web one", () => {
    const warning = googleSignInConfigWarning({ GOOGLE_IOS_CLIENT_ID: IOS })
    expect(warning).toContain("GOOGLE_WEB_CLIENT_ID")
    // The reason has to survive, not just the variable name — someone reading
    // this line at 2am needs to know why the *web* id matters to a phone.
    expect(warning).toContain("web")
  })

  it("warns for android-only too, not just ios", () => {
    expect(googleSignInConfigWarning({ GOOGLE_ANDROID_CLIENT_ID: ANDROID })).toContain(
      "GOOGLE_WEB_CLIENT_ID"
    )
  })

  it("warns when nothing is configured, because sign-in still fails closed", () => {
    // Not the same failure: this one is a legitimate email-only deployment,
    // so the message says so rather than implying a mistake.
    const warning = googleSignInConfigWarning({})
    expect(warning).toContain("every Google sign-in will be rejected")
    expect(warning).toContain("email sign-in is unaffected")
  })

  it("is silent once the web client id is present", () => {
    expect(googleSignInConfigWarning({ GOOGLE_WEB_CLIENT_ID: WEB })).toBeNull()
    expect(
      googleSignInConfigWarning({
        GOOGLE_WEB_CLIENT_ID: WEB,
        GOOGLE_IOS_CLIENT_ID: IOS,
        GOOGLE_ANDROID_CLIENT_ID: ANDROID,
      })
    ).toBeNull()
  })

  it("treats an empty string as unset, since that is how a cleared variable arrives", () => {
    expect(googleSignInConfigWarning({ GOOGLE_WEB_CLIENT_ID: "", GOOGLE_IOS_CLIENT_ID: IOS })).toContain(
      "GOOGLE_WEB_CLIENT_ID"
    )
  })
})
