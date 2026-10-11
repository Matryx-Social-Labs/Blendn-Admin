/**
 * The dependency audit's standing exceptions, and the one place that decides
 * whether a high or critical advisory blocks the build.
 *
 * `.github/workflows/ci.yml` runs `npm audit --audit-level=high` and, only when
 * that reports something, hands `npm audit --json` to this file. Exit 0 means
 * every finding is on the list below and still qualifies; anything else exits 1
 * and the build stays red.
 *
 * An exception is for ONE advisory on ONE package, never for a package or a
 * severity, and it has to keep earning its place on every run:
 *
 * - the package must not be in the production tree (`npm ls --omit=dev`), so an
 *   exception granted for a lint-time dependency cannot quietly cover the same
 *   package arriving in the shipped server;
 * - it ends on `until`, after which the gate is red again. That date is the
 *   revisit: an exception with no end is a gate with a hole in it.
 *
 * Nothing here is a way to make a red build green. If a patched release exists,
 * upgrade; add to this list only when none does.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

export interface AuditException {
  /** The advisory, by GHSA id. */
  advisory: string
  /** The package the advisory is filed against. */
  pkg: string
  /** Last day (UTC, YYYY-MM-DD) the exception holds. */
  until: string
  why: string
}

export const AUDIT_EXCEPTIONS: readonly AuditException[] = [
  {
    advisory: "GHSA-vfj7-8cjw-p6xm",
    pkg: "braces",
    until: "2026-11-30",
    why:
      "braces <= 3.0.3 overflows the stack on a deeply nested brace pattern. No patched release exists " +
      "(3.0.3 is the latest; micromatch/braces#70 is open, upstream's last commit is January 2025). " +
      "The only path is eslint-config-next > @next/eslint-plugin-next > fast-glob@3.3.1 (an exact pin) > micromatch, " +
      "which globs our own repository when ESLint runs: no untrusted input, and not in the production tree. " +
      "Revisit by `until`: a braces fix, or an @next/eslint-plugin-next that no longer pulls fast-glob.",
  },
]

export interface Advisory {
  name: string
  severity: string
  url: string
}

export interface AuditReport {
  vulnerabilities?: Record<string, { via: Array<string | Advisory> }>
}

const BLOCKING_SEVERITIES = new Set(["high", "critical"])

/** The advisories (not the packages that merely depend on a vulnerable one) at high or above, once each. */
function highAdvisories(report: AuditReport): Advisory[] {
  if (!report.vulnerabilities) {
    // An outage, an auth failure and a changed output format all look like this. None of them is a clean audit.
    throw new Error("not an npm audit report: no `vulnerabilities` key")
  }
  const byUrl = new Map<string, Advisory>()
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (typeof via === "object" && BLOCKING_SEVERITIES.has(via.severity)) byUrl.set(via.url, via)
    }
  }
  return [...byUrl.values()]
}

/**
 * Each high or critical advisory, sorted into the ones a live exception covers
 * and the ones that block.
 */
export function judge(
  report: AuditReport,
  now: Date,
  inProduction: (pkg: string) => boolean,
  exceptions: readonly AuditException[] = AUDIT_EXCEPTIONS
): { excused: Advisory[]; blocking: Advisory[] } {
  const today = now.toISOString().slice(0, 10)
  const excused: Advisory[] = []
  const blocking: Advisory[] = []
  for (const advisory of highAdvisories(report)) {
    const exception = exceptions.find((e) => advisory.url.endsWith(`/${e.advisory}`) && advisory.name === e.pkg)
    const live = exception !== undefined && today <= exception.until && !inProduction(exception.pkg)
    ;(live ? excused : blocking).push(advisory)
  }
  return { excused, blocking }
}

/** Whether npm resolves the package from the production dependencies. Anything unreadable says yes. */
export function installedInProduction(pkg: string): boolean {
  let stdout: string
  try {
    stdout = execFileSync("npm", ["ls", pkg, "--omit=dev", "--all", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch (error) {
    // `npm ls <pkg>` exits 1 when the package is not found, which is the answer being asked for.
    stdout = (error as { stdout?: string }).stdout ?? ""
  }
  try {
    return "dependencies" in (JSON.parse(stdout) as object)
  } catch {
    return true
  }
}

function main(): void {
  const report = JSON.parse(readFileSync(0, "utf8")) as AuditReport
  const { excused, blocking } = judge(report, new Date(), installedInProduction)
  for (const a of excused) console.log(`excused: ${a.name} ${a.severity} ${a.url}`)
  for (const a of blocking) console.log(`blocking: ${a.name} ${a.severity} ${a.url}`)
  process.exit(blocking.length > 0 ? 1 : 0)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error("audit gate failed closed:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
