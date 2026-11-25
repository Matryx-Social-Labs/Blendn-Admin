import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

import { crewLinkUrl } from "@/lib/crews/links"
import { ticketOrderEmail } from "@/lib/email"
import { applyAgainHtml } from "@/lib/email-html"
import { publicSiteOrigin, publicSiteOriginProblem, validateEnv } from "@/lib/env"
import { eventShareUrl } from "@/lib/event-share"
import { inviteUrl } from "@/lib/friends"

/*
 * SCRUM-1366: links the server builds follow `PUBLIC_SITE_ORIGIN`.
 *
 * Staging handed out production links — the printed door QR, the friend and
 * crew links, the mails' "Visit" links — because each was a `www.blendn.app`
 * literal. One value, server config only (never a request header: these go
 * into QR codes and mails), default www so production is unchanged byte for byte.
 */

const WWW = "https://www.blendn.app"
const STAGING = "https://staging.blendn.app"
const ID = "3f6c1e9a-0b7d-4c2e-9a51-6d2f8e4b7c10"
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv"

const BASE = {
  DATABASE_URL: "postgresql://x",
  NEXTAUTH_URL: "http://localhost:3000",
  NEXTAUTH_SECRET: "x".repeat(32),
  MOBILE_JWT_SECRET: "y".repeat(32),
}

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function withOrigin(origin: string | undefined, environmentName?: string) {
  process.env = { ...saved, ...BASE, PUBLIC_SITE_ORIGIN: origin, RAILWAY_ENVIRONMENT_NAME: environmentName } as NodeJS.ProcessEnv
  if (origin === undefined) delete process.env.PUBLIC_SITE_ORIGIN
}

function links() {
  return {
    door: eventShareUrl(ID),
    invite: inviteUrl(TOKEN),
    crew: crewLinkUrl(TOKEN),
    ticketMail: ticketOrderEmail({ subject: "s", heading: "h", paragraphs: [], orderId: ID }).text,
    applyMail: applyAgainHtml("pending", `${BASE.NEXTAUTH_URL}/login`),
  }
}

describe("with PUBLIC_SITE_ORIGIN unset (production)", () => {
  it("builds every link on www exactly as before", () => {
    withOrigin(undefined)
    const l = links()
    expect(publicSiteOrigin()).toBe(WWW)
    expect(l.door).toBe(`${WWW}/event/${ID}`)
    expect(l.invite).toBe(`${WWW}/f/${TOKEN}`)
    expect(l.crew).toBe(`${WWW}/c/${TOKEN}`)
    expect(l.ticketMail.endsWith(`\n${WWW}`)).toBe(true)
    expect(l.applyMail).toContain(`href="${WWW}"`)
    expect(l.applyMail).not.toContain(STAGING)
  })
})

describe("with PUBLIC_SITE_ORIGIN set to the staging site", () => {
  it("builds the door QR, share, friend, crew and mail links on it", () => {
    withOrigin(STAGING, "staging")
    const l = links()
    expect(l.door).toBe(`${STAGING}/event/${ID}`)
    expect(l.invite).toBe(`${STAGING}/f/${TOKEN}`)
    expect(l.crew).toBe(`${STAGING}/c/${TOKEN}`)
    expect(l.ticketMail.endsWith(`\n${STAGING}`)).toBe(true)
    expect(l.applyMail).toContain(`href="${STAGING}"`)
    expect(l.applyMail).not.toContain(`href="${WWW}"`)
    // The logo images stay on www: an image host, not a link anybody follows.
    expect(l.applyMail).toContain(`${WWW}/brand/lockup-dark.png`)
  })
})

describe("publicSiteOriginProblem", () => {
  it.each([
    [undefined, undefined],
    ["", "staging"],
    [STAGING, "staging"],
    [STAGING, undefined],
    [WWW, "production"],
    [undefined, "production"],
  ])("accepts %p in %p", (origin, env) => {
    expect(publicSiteOriginProblem(origin, env)).toBeNull()
  })

  it.each([
    ["http://staging.blendn.app", "staging"],
    [`${STAGING}/`, "staging"],
    [`${STAGING}/event`, "staging"],
    [`${STAGING}?x=1`, "staging"],
    [`${STAGING}#x`, "staging"],
    ["https://user:pw@staging.blendn.app", "staging"],
    ["https://Staging.blendn.app", "staging"],
    ["staging.blendn.app", "staging"],
    ["not a url", "staging"],
    [STAGING, "production"],
    ["https://blendn.app", "production"],
  ])("refuses %p in %p", (origin, env) => {
    expect(publicSiteOriginProblem(origin, env)).toEqual(expect.any(String))
  })
})

describe("validateEnv", () => {
  it("boots with the staging origin on staging, and with it unset", () => {
    withOrigin(STAGING, "staging")
    expect(() => validateEnv()).not.toThrow()
    withOrigin(undefined, "production")
    expect(() => validateEnv()).not.toThrow()
  })

  it.each([
    ["a path", `${STAGING}/x`, "staging"],
    ["http", "http://staging.blendn.app", "staging"],
    ["a staging origin in production", STAGING, "production"],
  ])("refuses to boot with %s", (_label, origin, env) => {
    withOrigin(origin, env)
    expect(() => validateEnv()).toThrow("Invalid environment variables")
  })

  it("and the helper refuses a value boot would have refused, rather than mint a bad link", () => {
    withOrigin(`${STAGING}/x`, "staging")
    expect(() => publicSiteOrigin()).toThrow(/PUBLIC_SITE_ORIGIN/)
  })
})

/*
 * The guard. A new `"https://www.blendn.app/…"` literal in server code is a
 * link that will point at production from staging. Build it with
 * `publicSiteOrigin()` instead. The exceptions are links that are rightly fixed.
 */
const ROOT = join(__dirname, "..")
const FIXED: Record<string, string> = {
  "lib/env.ts": "the default itself",
  "lib/company.ts": "the privacy policy: a legal page, one copy, the app links to the same",
  "lib/email-html.ts": "BRAND_ASSETS: the mail logos are images on the production site, not links",
  "app/about/page.tsx": "names the public product site in prose",
}
const LITERAL = /["'`]https:\/\/www\.blendn\.app[^"'`]*["'`]/g

/** Comments out, URLs kept: `stripComments` cuts a line at the `//` of `https://`. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

describe("no hard-coded www.blendn.app link outside the helper", () => {
  it("lib/, app/ and components/ build site links with publicSiteOrigin()", () => {
    const found: string[] = []
    for (const dir of ["lib", "app", "components"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, file)
        // OpenAPI text describes the shape of a link; it builds none.
        if (rel.startsWith("lib/openapi/")) continue
        const hits = code(readFileSync(file, "utf8")).match(LITERAL) ?? []
        const allowed = FIXED[rel]
        for (const hit of hits) {
          if (allowed && (rel !== "lib/email-html.ts" || hit.includes("/brand"))) continue
          found.push(`${rel}: ${hit}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
