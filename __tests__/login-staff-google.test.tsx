import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"

/*
 * /login and the staff Google door (SCRUM-1241; approved mockup: Option A, advisor-adjusted).
 *
 * With `DASHBOARD_GOOGLE_*` unset, which is every environment today, the page must be the page it was: the fixture is
 * dev's own render of /login, captured at a65c2968 before this change, and the new page must match it byte for byte.
 * With the client set, the card gains one section under a hairline: "Platform staff · @matrixsociallabs.com" and the
 * Google button. A refused Google account comes back as `?error=…` and is said in fixed words, never echoed.
 */
jest.mock("next-auth/react", () => ({ signIn: jest.fn(), useSession: () => ({ status: "unauthenticated", data: null }) }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }))
jest.mock("next/server", () => ({ connection: async () => undefined }))

import LoginPage from "@/app/login/page"
import { signinFailure } from "@/app/login/sign-in-form"

const BEFORE = readFileSync(`${__dirname}/fixtures/login-form-before-sso.html`, "utf8").trimEnd()
const CLIENT = { DASHBOARD_GOOGLE_CLIENT_ID: "dash-web.apps.googleusercontent.com", DASHBOARD_GOOGLE_CLIENT_SECRET: "dash-secret" }

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})
function withEnv(extra: Record<string, string | undefined>) {
  process.env = { ...saved, DASHBOARD_GOOGLE_CLIENT_ID: undefined, DASHBOARD_GOOGLE_CLIENT_SECRET: undefined, ADMIN_SSO_REQUIRED: undefined, ...extra } as NodeJS.ProcessEnv
}

async function render(searchParams: Record<string, string> = {}) {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(searchParams) }))
}

describe("with the dashboard Google client unset", () => {
  it("renders the page it rendered before, byte for byte", async () => {
    withEnv({})
    expect(await render()).toBe(BEFORE)
  })

  it("ignores a Google error in the address: there is no Google door to talk about", async () => {
    withEnv({})
    expect(await render({ error: "AccessDenied" })).toBe(BEFORE)
  })

  it("ignores ADMIN_SSO_REQUIRED alone: boot refuses that configuration, and the page never names a door it lacks", async () => {
    withEnv({ ADMIN_SSO_REQUIRED: "true" })
    expect(await render()).toBe(BEFORE)
  })
})

describe("with the client set", () => {
  it("adds the staff section under the card's last line: the label names the domain, the button points at it", async () => {
    withEnv(CLIENT)
    const html = await render()
    const at = html.indexOf("Forgotten your password?")
    const staff = html.slice(at)
    // The domain is one unbreakable word: at the largest text it breaks inside rather than running out of the card.
    expect(staff).toMatch(/<p id="staff-google-label" class="[^"]*wrap-anywhere[^"]*"/)
    expect(staff).toContain("Platform staff · @matrixsociallabs.com")
    expect(staff).toMatch(/<button[^>]*type="button"[^>]*aria-describedby="staff-google-label"[^>]*>.*Sign in with Google<\/button>/)
    // Wraps at large text rather than running out of the card, and is a 44 px target.
    expect(staff).toMatch(/<button[^>]*class="[^"]*whitespace-normal[^"]*min-h-11[^"]*"/)
    // Everything before the section is today's card.
    expect(html.slice(0, at)).toBe(BEFORE.slice(0, BEFORE.indexOf("Forgotten your password?")))
  })

  it("says a refused Google account in fixed words, between the label and the button", async () => {
    withEnv(CLIENT)
    const html = await render({ error: "AccessDenied" })
    expect(html).toMatch(/Platform staff · @matrixsociallabs.com<\/p><p[^>]*role="alert"[^>]*>That Google account isn&#x27;t a Blend&#x27;n staff account.<\/p><button/)
    expect(html).not.toContain('id="signin-error"')
  })

  it.each([
    ["OAuthAccountNotLinked", "This browser is signed in as someone else. Sign out, then try again."],
    ["OAuthCallback", "Google sign-in didn&#x27;t finish. Try again."],
    ["OAuthSignin", "Google sign-in didn&#x27;t finish. Try again."],
    ["Callback", "Google sign-in didn&#x27;t finish. Try again."],
  ])("says %s in its own words", async (code, words) => {
    withEnv(CLIENT)
    expect(await render({ error: code })).toContain(words)
  })

  it("never renders the parameter itself", async () => {
    withEnv(CLIENT)
    const html = await render({ error: "<img src=x onerror=alert(1)>" })
    expect(html).not.toContain("onerror")
    expect(html).not.toContain('role="alert"')
  })
})

describe("a password refused at the form", () => {
  it("tells a staff address to use Google when the flag is on: the same refusal a wrong password gets, pointed at the button", () => {
    expect(signinFailure("priya.nair@matrixsociallabs.com", "required")).toBe("Staff sign in with Google. Use the button below.")
    expect(signinFailure(" Priya.Nair@MatrixSocialLabs.com ", "required")).toBe("Staff sign in with Google. Use the button below.")
  })

  it("keeps the one message for everyone else, and for staff while the flag is off", () => {
    const generic = "That email and password don't match an operator account."
    expect(signinFailure("organizer@blendn.app", "required")).toBe(generic)
    expect(signinFailure("priya.nair@matrixsociallabs.com", "on")).toBe(generic)
    expect(signinFailure("priya.nair@matrixsociallabs.com", "off")).toBe(generic)
    // A look-alike domain is not the staff domain.
    expect(signinFailure("priya@notmatrixsociallabs.com", "required")).toBe(generic)
  })
})
