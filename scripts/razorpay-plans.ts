/**
 * Make Razorpay's plans match `BILLING_PLANS` (lib/billing-plans.ts).
 *
 *   npx tsx scripts/razorpay-plans.ts            # dry run: what exists, what would be created
 *   npx tsx scripts/razorpay-plans.ts --apply    # create the missing ones
 *
 * Run it directly with `npx tsx`, not through `npm run`: npm 11 drops a
 * `--apply` given to `npm run` (memory: npm-run-eats-double-dash-flags).
 *
 * Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the environment, and holds
 * them to the same mode rule as the server: a `rzp_live_` key refuses to run
 * outside RAILWAY_ENVIRONMENT_NAME=production. Prints plan ids and prices,
 * never a key.
 *
 * Razorpay plans cannot be edited or deleted. A price change in the table
 * makes the old plan stop matching (`planMatches`), this script creates the
 * new one, and checkout moves to it; existing subscribers stay on the plan
 * they bought. The Event Pass is an Order created per purchase, so it has no
 * plan here.
 */
import { BILLING_PLANS, chargeMinor, grossRupees, rupees } from "../lib/billing-plans"
import { createPlan, listPlans, planMatches, razorpayConfig } from "../lib/razorpay"

const APPLY = process.argv.includes("--apply") || process.argv.includes("apply")

async function main() {
  const config = razorpayConfig()
  if (!config) {
    console.error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set. Nothing to do.")
    process.exit(1)
  }
  console.log(`Razorpay ${config.keyId.startsWith("rzp_live_") ? "LIVE" : "test"} mode · ${APPLY ? "applying" : "dry run"}`)

  const remote = await listPlans()
  const wanted = Object.values(BILLING_PLANS).filter((p) => p.kind === "subscription")

  for (const plan of wanted) {
    const price = `${rupees(grossRupees(plan))} (${chargeMinor(plan)} paise) / ${plan.period}`
    const match = remote.find((r) => planMatches(r, plan))
    if (match) {
      console.log(`  ok       ${plan.key.padEnd(18)} ${price}  → ${match.id}`)
      continue
    }
    if (!APPLY) {
      console.log(`  missing  ${plan.key.padEnd(18)} ${price}  (would create)`)
      continue
    }
    const created = await createPlan(plan)
    console.log(`  created  ${plan.key.padEnd(18)} ${price}  → ${created.id}`)
  }
  if (!APPLY) console.log("Dry run. Re-run with --apply to create the missing plans.")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
