import { readFileSync } from "fs"
import { join } from "path"

import { SEED_PERSONAS } from "../scripts/test-accounts"

/*
 * Every person seed-qa makes with the shared password is re-asserted on
 * deploy only if it is in SEED_PERSONAS. A new attendee added to seed-qa and
 * not to the list is the 2026-09-24 lockout again: signed in fine the day it
 * was seeded, 401 after the next password rotation.
 */
const seedQa = readFileSync(join(__dirname, "..", "scripts", "seed-qa.ts"), "utf8")
const seeded = [...seedQa.matchAll(/email: "([a-z.]+@blendn\.app)"/g)].map((m) => m[1])

it("finds the people seed-qa makes", () => {
  expect(seeded.length).toBeGreaterThanOrEqual(11)
})

it("lists every one of them for the deploy step", () => {
  expect(seeded.filter((email) => !SEED_PERSONAS.includes(email))).toEqual([])
})
