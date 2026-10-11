import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * RG-G01 / SEC-09: a venue never gets a list of its regulars (step 12, plan
 * v2 §2).
 *
 * An offer is blind: the venue picks the words and a rule, and we deliver.
 * What it sees of an offer is three counts. The one list of people a venue
 * ever sees is the regulars who said "let this venue know I'm a regular" —
 * built FROM `venue_regular_optins`, so nobody is on it who did not put
 * themselves there. This guard holds the code to that, structurally:
 *
 *   1. Only the regulars modules touch the three tables (an offer's sends,
 *      the opt-ins, the mutes), plus the account erasure's deletes.
 *   2. Only `lib/offers/deliver.ts` reads who an offer went to — a Prisma
 *      select of `user_id` or `user` on `venue_offer_sends` anywhere else
 *      fails. The send writes the audience with `INSERT … SELECT` and returns
 *      only the offer: its SQL names `user_id` exactly twice (the column list
 *      and the audience's column), and no `RETURNING` returns it.
 *   3. In the venue-facing modules, any SQL that reads a name, email or
 *      handle is driven FROM `venue_regular_optins`.
 *   4. What the venue's view and actions return is pinned field by field: no
 *      `recipients`, no ids beyond the offer's own.
 *
 * Brace- and paren-matched, never a negated character class across a
 * delimiter (playbook §2). The behaviour — a canary name absent from every
 * venue-facing answer until that person opts in — is regulars.itest.ts.
 */

const ROOT = join(__dirname, "..")
const SEARCH = ["app", "components", "lib", "scripts"]
const TABLES = ["venue_offer_sends", "venue_regular_optins", "venue_offer_mutes"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const files = [...SEARCH.flatMap((d) => walk(join(ROOT, d))), join(ROOT, "server.ts")].map((f) => ({
  rel: relative(ROOT, f),
  code: stripComments(readFileSync(f, "utf8")),
}))
const file = (rel: string) => {
  const f = files.find((x) => x.rel === rel)
  if (!f) throw new Error(`${rel} not found`)
  return f.code
}

/** The text from `open` to its matching close, inclusive. */
function matched(code: string, start: number, open: string, close: string): string {
  let depth = 0
  for (let i = start; i < code.length; i++) {
    if (code[i] === open) depth++
    else if (code[i] === close && --depth === 0) return code.slice(start, i + 1)
  }
  return code.slice(start)
}

export function touchesTable(code: string, table: string): boolean {
  return (
    new RegExp(`\\.\\s*${table}\\b`).test(code) ||
    new RegExp(`\\b(?:from|into|update|join)\\s+"?${table}"?\\b`, "i").test(code) ||
    new RegExp(`\\{[\\s\\w,:]*\\b${table}\\b[\\s\\w,:]*\\}\\s*=`).test(code)
  )
}

/** Every Prisma call's argument on a table: `.venue_offer_sends.findMany( … )`. */
export function callsOn(code: string, table: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(new RegExp(`\\.\\s*${table}\\s*\\.\\s*\\w+\\s*\\(`, "g"))) {
    out.push(matched(code, m.index + m[0].length - 1, "(", ")"))
  }
  return out
}

/** A call's argument reads who: a `user_id` or `user` relation under a select or include. */
export function readsWho(call: string): boolean {
  for (const m of call.matchAll(/\b(?:select|include)\s*:\s*\{/g)) {
    const block = matched(call, m.index + m[0].length - 1, "{", "}")
    if (/\buser_id\b|\buser\s*:/.test(block)) return true
  }
  return false
}

/**
 * The body of the template literal opening at `start` (a backtick), with each
 * `${…}` replaced by `${}` — nested templates inside it are skipped whole, so a
 * `${`offers:${id}`}` cannot pair the wrong backticks.
 */
function templateAt(code: string, start: number): { body: string; end: number } {
  let body = ""
  let j = start + 1
  while (j < code.length) {
    const c = code[j]
    if (c === "\\") {
      body += code.slice(j, j + 2)
      j += 2
    } else if (c === "`") {
      return { body, end: j }
    } else if (c === "$" && code[j + 1] === "{") {
      let depth = 1
      j += 2
      while (j < code.length && depth > 0) {
        if (code[j] === "`") j = templateAt(code, j).end
        else if (code[j] === "{") depth++
        else if (code[j] === "}") depth--
        j++
      }
      body += "${}"
    } else {
      body += c
      j++
    }
  }
  return { body, end: j }
}

/** Every raw SQL template in a file: `$queryRaw`, `$executeRaw`, `Prisma.sql`. */
export function templates(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/(?:\$queryRaw|\$executeRaw|Prisma\.sql)\b/g)) {
    const tick = code.indexOf("`", m.index)
    if (tick >= 0) out.push(templateAt(code, tick).body)
  }
  return out
}

/** The column list after each RETURNING. */
export function returning(sql: string): string[] {
  return [...sql.matchAll(/\bRETURNING\s+((?:[\w.]+\s*,\s*)*[\w.]+)/gi)].map((m) => m[1])
}

const VENUE_FACING = (rel: string) =>
  rel === "lib/offers/venue.ts" || rel === "lib/offer-actions.ts" || rel.startsWith("app/dashboard/") || rel.startsWith("components/")

describe("the detectors", () => {
  it("find a Prisma read of who an offer went to, however it is spelled", () => {
    const [plain] = callsOn("db.venue_offer_sends.findMany({ where: { offer_id: id }, select: { user_id: true } })", "venue_offer_sends")
    expect(readsWho(plain)).toBe(true)
    const [nested] = callsOn(
      "tx . venue_offer_sends.findMany({ where: { offer_id: id }, select: { id: true, user: { select: { name: true } } } })",
      "venue_offer_sends"
    )
    expect(readsWho(nested)).toBe(true)
    const [included] = callsOn("db.venue_offer_sends.findFirst({ include: { user: true } })", "venue_offer_sends")
    expect(readsWho(included)).toBe(true)
    // Filtering by the caller's own id is not reading anybody's.
    const [own] = callsOn("db.venue_offer_sends.findMany({ where: { user_id: me }, select: { id: true } })", "venue_offer_sends")
    expect(readsWho(own)).toBe(false)
  })

  it("find the tables in raw SQL and in a destructuring", () => {
    expect(touchesTable("SELECT 1 FROM venue_offer_sends s", "venue_offer_sends")).toBe(true)
    expect(touchesTable('INSERT INTO "venue_regular_optins" VALUES (1)', "venue_regular_optins")).toBe(true)
    expect(touchesTable("const { venue_offer_mutes } = db", "venue_offer_mutes")).toBe(true)
    expect(touchesTable('const label = "venue offer sends"', "venue_offer_sends")).toBe(false)
  })

  it("reads a RETURNING list", () => {
    expect(returning("INSERT INTO t (a) VALUES (1) RETURNING id, user_id")).toEqual(["id, user_id"])
    expect(returning("INSERT INTO t (a) VALUES (1) RETURNING o.id")).toEqual(["o.id"])
  })
})

describe("a venue never gets a list of its regulars (RG-G01)", () => {
  it("scans the tree at all", () => {
    const rels = files.map((f) => f.rel)
    for (const rel of ["lib/offers/deliver.ts", "lib/offers/venue.ts", "lib/offer-actions.ts", "app/dashboard/venues/[id]/page.tsx"]) {
      expect(rels).toContain(rel)
    }
  })

  it("only the regulars modules, and the erasure, touch the tables", () => {
    const allowed = [
      "app/api/mobile/account/route.ts",
      "lib/offer-actions.ts",
      "lib/offers/deliver.ts",
      "lib/offers/person.ts",
      "lib/offers/venue.ts",
      "lib/regulars.ts",
    ]
    const touching = files.filter((f) => TABLES.some((t) => touchesTable(f.code, t))).map((f) => f.rel)
    expect(touching.filter((rel) => !allowed.includes(rel))).toEqual([])
  })

  it("only lib/offers/deliver.ts reads who an offer went to", () => {
    const readers = files.filter((f) => callsOn(f.code, "venue_offer_sends").some(readsWho)).map((f) => f.rel)
    expect(readers).toEqual(["lib/offers/deliver.ts"])
  })

  it("the send writes the audience and returns only the offer", () => {
    const sql = templates(file("lib/offer-actions.ts")).filter((t) => /venue_offer_sends/.test(t))
    expect(sql).toHaveLength(1)
    // The INSERT's column list and the audience's column: nowhere else.
    expect(sql[0].match(/\buser_id\b/g)).toHaveLength(2)
    expect(sql[0]).toMatch(/INSERT INTO venue_offer_sends \(offer_id, venue_id, user_id, sent_at\)/)
    for (const list of returning(sql[0])) expect(list).not.toMatch(/user_id/)
  })

  it("no venue-facing SQL returns or selects an offer audience's ids", () => {
    const leaks: string[] = []
    for (const f of files.filter((x) => VENUE_FACING(x.rel) && x.rel !== "lib/offer-actions.ts")) {
      for (const t of templates(f.code).filter((s) => /venue_offer_sends|venue_offers/.test(s))) {
        if (/\buser_id\b/.test(t)) leaks.push(f.rel)
      }
    }
    expect(leaks).toEqual([])
  })

  it("a name, email or handle reaches a venue only from a person's own yes", () => {
    const named: string[] = []
    for (const f of files.filter((x) => VENUE_FACING(x.rel))) {
      for (const t of templates(f.code)) {
        if (!/venue_offer|venue_regular|regulars/.test(t)) continue
        if (!/\.name\b|\bemail\b|\bhandle\b|"name"/.test(t)) continue
        // The driving table, the first FROM: the opt-ins, or it is a list of people nobody agreed to.
        const from = /\bFROM\s+"?(\w+)"?/i.exec(t)?.[1]
        if (from !== "venue_regular_optins") named.push(f.rel)
      }
      for (const t of TABLES) {
        for (const call of callsOn(f.code, t)) if (/\b(?:name|email|handle)\s*:\s*true/.test(call)) named.push(`${f.rel} (${t})`)
      }
    }
    expect(named).toEqual([])
  })

  it("what the venue is given is pinned field by field (RG-C01)", () => {
    const venue = file("lib/offers/venue.ts")
    const fields = (name: string) => {
      const at = venue.indexOf(`export interface ${name} {`)
      expect(at).toBeGreaterThanOrEqual(0)
      const body = matched(venue, venue.indexOf("{", at), "{", "}")
      return [...body.slice(1, -1).matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1])
    }
    // No results of its own per offer (the overlapping-sends rule): opened and redeemed only as totals.
    expect(fields("OfferResult")).toEqual(["id", "text", "createdAt", "endsAt", "live", "sent"])
    expect(fields("OfferTotals")).toEqual(["asOf", "sent", "opened", "redeemed"])
    expect(fields("KnownRegular")).toEqual(["firstName", "nights"])
    expect(fields("VenueOffersView")).toEqual(["perWeek", "sentThisWeek", "nextAt", "offers", "totals", "known"])
    const actions = file("lib/offer-actions.ts")
    expect(actions).toMatch(/export async function sendOffer\([\s\S]*?\): Promise<\{ offerId: string; sent: number \}>/)
    expect(actions).toMatch(/export async function redeemPass\([\s\S]*?\): Promise<\{ text: string \}>/)
  })

  it("the view is asked whose it is, and counts stop where the venue's day began (the differencing rule)", () => {
    const venue = file("lib/offers/venue.ts")
    expect(venue).toMatch(/export async function venueOffersView\(\s*venueId: string,\s*viewer:/)
    expect(venue).toMatch(/\(await actorFor\(viewer\)\)\.orgIds\.includes\(v\.owner_org_id\)/)
    // The totals read only what happened before `to`, the start of the venue's today.
    const totals = templates(venue).find((t) => /count\(s\.opened_at\)/.test(t))
    expect(totals).toBeDefined()
    expect(totals).toMatch(/FILTER \(WHERE s\.opened_at < \$\{\}\)/)
    expect(totals).toMatch(/FILTER \(WHERE s\.redeemed_at < \$\{\}\)/)
    expect(totals).toMatch(/o\.created_at < \$\{\}/)
    // Offers are the sending organisation's: every read names the owner org.
    for (const t of templates(venue).filter((x) => /venue_offers/.test(x))) expect(t).toMatch(/org_id = \$\{\}::uuid/)
  })

  it("no route hands a venue a recipient: each side imports only its own module (e)", () => {
    const imports = (code: string) => [...code.matchAll(/from\s+["'](@\/lib\/offers\/[\w-]+|@\/lib\/offer-actions)["']/g)].map((m) => m[1])
    const wrong: string[] = []
    for (const f of files.filter((x) => x.rel.startsWith("app/"))) {
      const used = imports(f.code)
      const allowed = f.rel.startsWith("app/api/mobile/")
        ? ["@/lib/offers/person"]
        : f.rel.startsWith("app/dashboard/")
          ? ["@/lib/offers/venue", "@/lib/offer-actions"]
          : []
      for (const u of used) if (!allowed.includes(u)) wrong.push(`${f.rel} imports ${u}`)
    }
    expect(wrong).toEqual([])
    // Nothing a venue reads carries a push token, a room handle or a pseudonym.
    const carrying = files
      .filter((f) => VENUE_FACING(f.rel) && /offer|regular/i.test(f.rel + f.code.slice(0, 2000)))
      .filter((f) => /\bpush_tokens\b|\broomHandle\(|\bpseudonym/.test(f.code) && /venue_offer|offers\//.test(f.code))
      .map((f) => f.rel)
    expect(carrying).toEqual([])
  })
})
