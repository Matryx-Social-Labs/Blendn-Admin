import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { Refusal, refusalMessage, STALE_PAGE_MESSAGE } from "@/lib/refusal"

import { stripComments } from "./support/strip-comments"

/**
 * A refusal a server action throws reaches the operator as its own sentence.
 *
 * Found on staging (SCRUM-139): "Remove Arjun Rao" — the last owner — was
 * refused correctly by `removeMember`, and the screen said "Minified React
 * error #441". Next.js strips the message of any error thrown in a server
 * action in production; only `digest` crosses. Ninety refusals had been
 * written as `throw new Error("…")`, driven in dev where the message shows,
 * and never seen by anyone on staging.
 *
 * Two halves, both guarded here: the throw must be a `Refusal` (message in the
 * digest), and the catch must read it with `refusalMessage`. A guard that
 * checked one half would pass with the other broken, which is a masked toast
 * again.
 */

const ROOT = join(__dirname, "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|itest|spec)\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const sources = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
const serverActionFiles = sources.filter((p) => /^"use server"/.test(readFileSync(p, "utf8")))

describe("the transport", () => {
  it("carries the sentence in the digest, which is what production forwards", () => {
    const thrown = new Refusal("This is the last owner. Promote someone else first.")
    expect(thrown.digest).toBe("refusal:This is the last owner. Promote someone else first.")
    // What the browser actually receives in production: the message replaced,
    // the digest intact. Built by hand because that is the only shape that
    // matters and no test runner produces it.
    const received = Object.assign(new Error("Minified React error #441; visit https://react.dev/errors/441"), {
      digest: thrown.digest,
    })
    expect(refusalMessage(received, "Could not remove")).toBe(
      "This is the last owner. Promote someone else first."
    )
  })

  it("never shows the mask, and keeps an ordinary error's own message", () => {
    expect(refusalMessage(new Error("Minified React error #441; visit …"), "Could not save")).toBe("Could not save")
    expect(
      refusalMessage(
        new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"),
        "Could not save"
      )
    ).toBe("Could not save")
    // The client's own throws (`new Error(await refusalText(res, …))`) were
    // always right and stay right.
    expect(refusalMessage(new Error("That did not go through"), "fallback")).toBe("That did not go through")
    expect(refusalMessage(undefined, "fallback")).toBe("fallback")
    expect(refusalMessage("a string", "fallback")).toBe("fallback")
    expect(refusalMessage(new Refusal(""), "fallback")).toBe("fallback")
  })

  it("tells a page that outlived a deploy to reload, instead of quoting Next's docs link (SCRUM-202)", () => {
    // Driven on staging: a venue owner with a traced fence on screen read
    // "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action".
    for (const message of [
      "Failed to find Server Action \"7f3a…\". This request might be from an older or newer deployment. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action",
      "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action",
    ]) {
      expect(refusalMessage(new Error(message), "Could not create the venue.")).toBe(STALE_PAGE_MESSAGE)
    }
  })
})

describe("every server action", () => {
  it("is found (the guard has something to guard)", () => {
    expect(serverActionFiles.length).toBeGreaterThan(20)
  })

  it("throws a Refusal at a person, never a bare Error whose message production strips", () => {
    const offenders = serverActionFiles
      .map((p) => ({ p, code: stripComments(readFileSync(p, "utf8")) }))
      .filter(({ code }) => /throw new Error\(/.test(code))
      .map(({ p }) => p.replace(ROOT + "/", ""))
    expect(offenders).toEqual([])
  })
})

describe("every catch that shows the message", () => {
  it("reads it through refusalMessage, not err.message, which is the mask in production", () => {
    const offenders = sources
      .map((p) => ({ p, code: stripComments(readFileSync(p, "utf8")) }))
      .filter(({ code }) => /toast\.\w+\(\s*\w+ instanceof Error \? \w+\.message/.test(code))
      .map(({ p }) => p.replace(ROOT + "/", ""))
    expect(offenders).toEqual([])
  })
})
