import { readFileSync } from "fs"
import { join, resolve } from "path"

/**
 * The version in `package.json` must have an entry in `CHANGELOG.md`.
 *
 * These drifted two releases apart without anyone noticing: `package.json` said
 * 0.44.1 while the changelog's newest entry was 0.43.0, so the host split — the
 * change most likely to be blamed when something broke — had no written record
 * at all. `/api/health` reports the `package.json` version, which meant the
 * running system named a release the repo could not explain.
 *
 * Nothing else checks this. A release is a number in one file and prose in
 * another, and only a human comparing them would ever notice they disagree.
 */

const ROOT = resolve(__dirname, "..")

describe("the changelog keeps up with the version", () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string
  }
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")

  it("has an entry for the current version", () => {
    // Keep a Changelog format: `## [0.45.0] - 2026-08-07`
    expect(changelog).toContain(`## [${version}]`)
  })

  it("lists that entry first", () => {
    // A back-filled entry below an older one means the release order in the file
    // does not match the release order that happened.
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
    expect(headings[0]).toBe(version)
  })

  it("names no version twice", () => {
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
    expect(headings).toEqual([...new Set(headings)])
  })
})
