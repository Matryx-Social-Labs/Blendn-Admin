import { readFileSync } from "fs"
import { join } from "path"
import { AUDIT_EXCEPTIONS, installedInProduction, judge, type Advisory, type AuditReport } from "@/scripts/audit-gate"

/**
 * The dependency audit may excuse a high advisory only when nothing can fix it,
 * and only on the terms in scripts/audit-gate.ts. Every case here is a way the
 * excuse could swallow something it was never meant to: the wrong advisory, the
 * wrong package, the shipped server, or forever.
 *
 * Origin: the nightlies of 2026-10-10 and 2026-10-11 failed on braces
 * (GHSA-vfj7-8cjw-p6xm), which has no patched release.
 */
const BRACES = "GHSA-vfj7-8cjw-p6xm"
const NOW = new Date("2026-10-12T03:00:00Z")
const advisory = (name: string, id: string, severity = "high"): Advisory => ({
  name,
  severity,
  url: `https://github.com/advisories/${id}`,
})

/** The shape `npm audit --json` writes: an advisory under the package it is filed against, and strings for the packages that only depend on it. */
function report(...advisories: Advisory[]): AuditReport {
  const vulnerabilities: NonNullable<AuditReport["vulnerabilities"]> = {
    micromatch: { via: ["braces"] },
    "eslint-config-next": { via: ["micromatch"] },
  }
  for (const a of advisories) vulnerabilities[a.name] = { via: [a, ...(vulnerabilities[a.name]?.via ?? [])] }
  return { vulnerabilities }
}

const devOnly = () => false
const shipped = () => true

describe("the audit gate's one exception", () => {
  it("excuses the braces advisory while braces is dev-only and the date has not passed", () => {
    const verdict = judge(report(advisory("braces", BRACES)), NOW, devOnly)

    expect(verdict.blocking).toEqual([])
    expect(verdict.excused.map((a) => a.name)).toEqual(["braces"])
  })

  it("holds through the last day and blocks the day after", () => {
    const until = AUDIT_EXCEPTIONS[0].until
    const lastDay = new Date(`${until}T23:59:59Z`)
    const dayAfter = new Date(`${until}T00:00:00Z`)
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1)

    expect(judge(report(advisory("braces", BRACES)), lastDay, devOnly).blocking).toEqual([])
    expect(judge(report(advisory("braces", BRACES)), dayAfter, devOnly).blocking.map((a) => a.name)).toEqual(["braces"])
  })

  it("blocks it the moment braces is in the production tree", () => {
    expect(judge(report(advisory("braces", BRACES)), NOW, shipped).blocking.map((a) => a.name)).toEqual(["braces"])
  })

  it("blocks every other high or critical advisory beside it", () => {
    const verdict = judge(
      report(advisory("braces", BRACES), advisory("next", "GHSA-cjq9-62q9-8jv4"), advisory("handlebars", "GHSA-xw65-4hp5-5hc7", "critical")),
      NOW,
      devOnly
    )

    expect(verdict.excused.map((a) => a.name)).toEqual(["braces"])
    expect(verdict.blocking.map((a) => a.name).sort()).toEqual(["handlebars", "next"])
  })

  it("does not reach a different advisory on the same package", () => {
    expect(judge(report(advisory("braces", "GHSA-aaaa-bbbb-cccc")), NOW, devOnly).blocking.map((a) => a.url)).toEqual([
      "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    ])
  })

  it("does not reach the same advisory id filed against another package", () => {
    expect(judge(report(advisory("micromatch", BRACES)), NOW, devOnly).blocking.map((a) => a.name)).toEqual(["micromatch"])
  })

  it("leaves moderate and low advisories to the audit level, which never asked about them", () => {
    const verdict = judge(report(advisory("sprintf-js", "GHSA-hp3w-g68c-fv3c", "moderate")), NOW, devOnly)

    expect(verdict).toEqual({ excused: [], blocking: [] })
  })

  it("fails closed on a body that is not an audit report", () => {
    // An unreachable advisory endpoint answers with an error object, not a clean audit.
    expect(() => judge({ error: { code: "ENOTFOUND" } } as AuditReport, NOW, devOnly)).toThrow(/not an npm audit report/)
  })

  it("holds an end date and a GHSA id on every entry", () => {
    for (const e of AUDIT_EXCEPTIONS) {
      expect(e.advisory).toMatch(/^GHSA(-[0-9a-z]{4}){3}$/)
      expect(e.until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.why.length).toBeGreaterThan(80)
    }
  })

  it("reads the production tree from npm: shipped code yes, lint tooling and strangers no", () => {
    expect(installedInProduction("next")).toBe(true)
    expect(installedInProduction("eslint")).toBe(false)
    expect(installedInProduction("no-such-package-in-this-tree")).toBe(false)
  }, 60_000)
})

describe("the workflow asks the gate and keeps its level", () => {
  const ci = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8")

  it("runs the audit at high with dev dependencies in, and only then consults scripts/audit-gate.ts", () => {
    // Comments name both commands; only an executed line counts.
    const lines = ci.split("\n").filter((l) => !l.trim().startsWith("#"))
    const code = lines.join("\n")
    const audit = code.indexOf("npm audit --audit-level=high")
    const gate = code.search(/npm audit --json[^\n]*\|\s*npx --no-install tsx scripts\/audit-gate\.ts/)

    expect(audit).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(audit)
    // The exception is for one advisory; loosening the gate itself would be for all of them.
    const auditLines = lines.filter((l) => /npm audit\b/.test(l))
    for (const line of auditLines) expect(line).not.toMatch(/--omit=dev|--production|--only=prod|--audit-level=(critical|moderate|low)/)
  })
})
