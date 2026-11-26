jest.mock("@/lib/db", () => ({ db: {} }))

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { OnboardingStopped } from "@/components/dashboard/overview-admin"
import { ONBOARDING_STEPS, type SignupCohorts } from "@/lib/loop-closure"

/*
 * Where onboarding stopped (SCRUM-1283).
 *
 * The steps are the client's: `ONBOARDING_STEPS` and `STEP_FIELDS` in the app's
 * lib/onboarding.ts, less `ready`, which writes nothing but `onboarded`. A step
 * added or reordered there has to be added here too, and this list is the diff
 * that says so.
 */
it("lists the app's onboarding steps, in its order", () => {
  expect(ONBOARDING_STEPS).toEqual(["basics", "preferences", "details", "media", "location"])
})

const steps = (people: number[]): SignupCohorts["steps"] =>
  (["none", ...ONBOARDING_STEPS, "finished"] as const).map((step, i) => ({ step, people: people[i] }))

const rows = (html: string) =>
  [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].slice(1).map((m) => m[1].replace(/<[^>]+>/g, "|").replace(/\|+/g, "|"))

it("shows one row per step in the app's order, then finished, and says the rows are the sign-ups above", () => {
  const html = renderToStaticMarkup(createElement(OnboardingStopped, { steps: steps([1962, 3104, 2240, 1511, 4880, 3, 7337]) }))
  expect(rows(html)).toEqual([
    "|Nothing yet|signed up, nothing filled|1,962|9%|",
    "|Basics|date of birth or gender|3,104|15%|",
    "|Preferences|intent, orientation or how you enter rooms|2,240|11%|",
    "|Details|interests or bio|1,511|7%|",
    "|Photos|a photo|4,880|23%|",
    "|Location|location sharing turned off|a few|",
    "|Finished onboarding|7,337|35%|",
  ])
  expect(html).toContain("Together the rows are the 21,037 sign-ups above.")
})

it("says a few under 5 with no share, and a real zero as 0", () => {
  const html = renderToStaticMarkup(createElement(OnboardingStopped, { steps: steps([9, 4, 2, 0, 6, 0, 41]) }))
  expect(rows(html)[1]).toBe("|Basics|date of birth or gender|a few|")
  expect(rows(html)[3]).toBe("|Details|interests or bio|0|0%|")
  expect(html).toContain("Together the rows are the 62 sign-ups above.")
})
