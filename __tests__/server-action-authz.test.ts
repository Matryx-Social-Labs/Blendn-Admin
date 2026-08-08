import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * Every server action authorises itself.
 *
 * A `"use server"` export is a POST endpoint. Next dispatches it by action id
 * with the page component nowhere in the path, so a `role !== "app_admin"`
 * redirect in `page.tsx` guards the view and not the data behind it. Four
 * exports relied on exactly that and were reachable by any organiser or venue
 * owner: the whole-platform admin report including every organiser's name and
 * email, every event on the platform including other people's drafts, the
 * moderation queue's flagged message content paired with the author's real
 * name and email, and any user's phone, age, location and role by id.
 *
 * Middleware is what stopped this being unauthenticated -- `/dashboard/:path*`
 * requires a session and rejects attendees. It is one control, it is not the
 * one that decides *which* dashboard user may read what, and it never sees the
 * action's arguments.
 *
 * So this asserts the shape rather than the four instances: a file that
 * declares `"use server"` must read the session somewhere. It cannot prove the
 * check is *correct* -- only that the data layer does not delegate its
 * authorisation entirely to a page it never runs behind.
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

/** Files whose every export is a server action. */
function serverActionFiles(): string[] {
  return ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) => {
    const head = readFileSync(f, "utf8").slice(0, 200)
    return /^\s*["']use server["']/.test(head)
  })
}

/** Any of the ways this codebase establishes who is calling. */
const READS_SESSION =
  /getAuth\(|await auth\(\)|requireUser\(|requireAdmin\(|requireOrgRole\(|actorFor\(/

describe("server actions authorise themselves", () => {
  const files = serverActionFiles()

  it("finds the server action files at all", () => {
    // Without this the suite below passes vacuously if the walk breaks.
    expect(files.length).toBeGreaterThan(10)
  })

  it("every 'use server' file reads the session", () => {
    const unguarded = files
      .filter((f) => !READS_SESSION.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(`${process.cwd()}/`, ""))

    // Listed rather than counted, so a failure names the file to fix.
    expect(unguarded).toEqual([])
  })
})
