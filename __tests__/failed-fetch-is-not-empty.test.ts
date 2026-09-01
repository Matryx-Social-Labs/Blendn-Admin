import { readFileSync, readdirSync } from "fs"
import { join, relative, sep } from "path"

/**
 * A failed fetch is not an empty result.
 *
 * ## The shape
 *
 * `components/chat-feed.tsx` polled the organiser's room every five seconds:
 *
 *     const res = await fetch(...)
 *     if (res.ok) { setData(await res.json()) }
 *     // no else
 *
 * A 403 or a 500 therefore changed nothing, and the render fell through to
 * `!data?.chatGroupId` - which says **"No chatroom for this event yet."** So an
 * organiser who had lost access to a room was told the room did not exist, and
 * a room that had started refusing simply froze on its last good render,
 * indistinguishable from a quiet night.
 *
 * `components/event-messaging.tsx` had it twice: a failed read rendered "No
 * sponsored messages yet. Add one to get started." - a failure explained as an
 * absence, and an invitation to duplicate something the caller could not read.
 *
 * This is the register's dominant theme wearing a client-side costume: the
 * mechanism reports success while failing. Every one of these renders is
 * *reassuring*, which is what makes them expensive.
 *
 * ## What is asserted
 *
 * A component that branches on `res.ok` must say what happens when it is not:
 * either an `else`, or an early return guarded by `!res.ok`. It cannot silently
 * fall through and leave the previous state standing in for an answer.
 *
 * The check is narrow on purpose. It does not police error *copy* or demand a
 * particular UI - only that the failing branch exists at all, which is the part
 * that was missing.
 */

const ROOT = join(__dirname, "..")

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(full, acc)
    else if (entry.name.endsWith(".tsx")) acc.push(full)
  }
  return acc
}

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

/**
 * Brace-match from `start`, returning the block and the index after it.
 *
 * Not a negated character class. Three guards in this repo were vacuous
 * because `[^}]*` stops at the first nested delimiter, and every one was found
 * by running the control rather than by reading the test.
 */
function blockAfter(src: string, start: number): { body: string; end: number } {
  const open = src.indexOf("{", start)
  if (open === -1) return { body: "", end: start }
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return { body: src.slice(open, i + 1), end: i + 1 }
    }
  }
  return { body: src.slice(open), end: src.length }
}

describe("a component never renders a failed fetch as an empty one", () => {
  const files = [...tsxFiles(join(ROOT, "components")), ...tsxFiles(join(ROOT, "app", "dashboard"))]

  it("finds components that fetch at all", () => {
    // Guards the walker: an empty list passes the assertion below vacuously.
    const fetching = files.filter((f) => readFileSync(f, "utf8").includes("fetch("))
    expect(fetching.length).toBeGreaterThan(5)
  })

  it("gives every res.ok branch a failing counterpart", () => {
    const silent: string[] = []

    for (const file of files) {
      const src = strip(readFileSync(file, "utf8"))
      if (!src.includes("fetch(")) continue

      /*
       * Scoped to the call, not the file.
       *
       * The first version exempted any file containing an `if (!res.ok)`
       * anywhere. `chat-feed.tsx` has one in `deleteMessage`, so the whole
       * file was exempt and the guard passed against the exact bug it was
       * written for. Caught by running the control, which is the only reason
       * it is not still passing.
       *
       * Each `fetch(` is now examined on its own: the window from the call to
       * the end of its handling must either check `!res.ok`, or give the
       * `res.ok` branch an `else`.
       */
      for (const call of src.matchAll(/fetch\s*\(/g)) {
        const window = src.slice(call.index!, call.index! + 700)
        if (/if\s*\(\s*!\s*res(?:ponse)?\.ok\s*\)/.test(window)) continue

        const ok = /if\s*\(\s*res(?:ponse)?\.ok\s*\)/.exec(window)
        if (!ok) continue // not a res.ok-shaped handler; nothing to say here

        const { end } = blockAfter(window, ok.index! + ok[0].length)
        if (/^\s*else\b/.test(window.slice(end))) continue

        silent.push(relative(ROOT, file).split(sep).join("/"))
        break
      }
    }

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      silent,
      hint:
        silent.length > 0
          ? "This branches on res.ok and says nothing when it is false, so a 403 renders as " +
            "an empty result. Add an else, or an early return on !res.ok."
          : "",
    }).toEqual({ silent: [], hint: "" })
  })
})
