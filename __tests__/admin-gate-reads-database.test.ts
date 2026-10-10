import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * An admin-only server action asks the database who is calling.
 *
 * `requireAdmin` (lib/current-user.ts) reads the caller's row: the role it
 * holds now, and nobody at all once suspended or deleted. Most admin actions
 * gated on `session.user.role` instead — the claim in the cookie — and six
 * files kept a local `requireAdmin` that did the same. A demoted admin kept
 * every admin action until their session was rebuilt.
 *
 * Two shapes are refused in a `"use server"` file:
 *   - a `requireAdmin` of its own, which is how the copies drifted;
 *   - the session-claim gate, in the forms this codebase wrote it.
 *
 * Mixed-role checks are not gates and stay (`session?.user && session.user.role
 * !== "app_admin"` choosing a branch, `actor.role !== "app_admin" && …`).
 * `__tests__/integration/admin-gate-reads-database.itest.ts` proves the
 * behaviour against a real row.
 */

const ROOTS = ["app", "lib"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === ".next") continue
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

const serverActionFiles = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) =>
  /^\s*["']use server["']/.test(readFileSync(f, "utf8").slice(0, 200))
)

/** Comments say what a gate used to be; only code counts. */
const code = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

const rel = (f: string) => f.replace(`${process.cwd()}/`, "")

const OWN_REQUIRE_ADMIN = /\bfunction\s+requireAdmin\b|\b(?:const|let)\s+requireAdmin\s*=/

const SESSION_CLAIM_GATE = [
  // if (!session?.user || session.user.role !== "app_admin") throw …
  /!session\?\.user\s*\|\|\s*session\??\.user\??\.role\s*!==\s*["']app_admin["']/,
  // if (session?.user?.role !== "app_admin") throw …
  /session\?\.user\?\.role\s*!==\s*["']app_admin["']/,
  // const user = await requireUser(); if (user.role !== "app_admin") throw …
  /\bif\s*\(\s*(?:user|session\.user)\.role\s*!==\s*["']app_admin["']\s*\)\s*(?:\{\s*)?throw\b/,
]

describe("admin-only server actions read the role from the database", () => {
  it("finds the server action files at all", () => {
    // Without this both checks below pass vacuously if the walk breaks.
    expect(serverActionFiles.length).toBeGreaterThan(20)
  })

  it("no 'use server' file keeps its own requireAdmin", () => {
    const own = serverActionFiles.filter((f) => OWN_REQUIRE_ADMIN.test(code(f))).map(rel)
    expect(own).toEqual([])
  })

  it("no 'use server' file gates on the session's role claim", () => {
    const gated = serverActionFiles
      .filter((f) => SESSION_CLAIM_GATE.some((shape) => shape.test(code(f))))
      .map(rel)
    // Listed rather than counted, so a failure names the file to fix.
    expect(gated).toEqual([])
  })

  it("the files that gate admins import the one requireAdmin", () => {
    const users = serverActionFiles.filter((f) => /\brequireAdmin\(/.test(code(f)))
    expect(users.length).toBeGreaterThan(15)
    for (const f of users) {
      expect([rel(f), /import \{[^}]*\brequireAdmin\b[^}]*\} from "@\/lib\/current-user"/.test(code(f))]).toEqual([rel(f), true])
    }
  })

  it("requireAdmin reads the caller's row, not the session's claim", () => {
    const src = code(join(process.cwd(), "lib/current-user.ts"))
    const fn = src.slice(src.indexOf("export async function requireAdmin("))
    expect(fn).toMatch(/const user = await currentUser\(\)/)
    expect(fn).not.toMatch(/getAuth\(/)
    const current = src.slice(src.indexOf("export async function currentUser("), src.indexOf("export async function requireAdmin("))
    expect(current).toMatch(/db\.user\.findUnique\(/)
    expect(current).toMatch(/return \{ id, role: row\.role \}/)
  })
})
