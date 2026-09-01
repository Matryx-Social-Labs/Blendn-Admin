/**
 * The account App Store and Play reviewers sign in with.
 *
 *   APP_REVIEW_EMAIL=... APP_REVIEW_PASSWORD=... DATABASE_URL=... npx tsx scripts/seed-review-account.ts
 *   npm run seed:review
 *
 * ## Why this is a script and not a fixture
 *
 * Production is wiped before launch. A demo account that lives only in a
 * database dump dies with it, and the failure surfaces as a rejected build a
 * week later rather than as a failed deploy. This must be re-runnable, and it
 * must be in `DEPLOYMENT.md` next to `db:migrate`.
 *
 * ## Idempotent
 *
 * Every write is an upsert or a guarded create, so running it twice is a no-op
 * and running it after a wipe restores the account. Re-running also resets the
 * password, which is what you want the day before a resubmission.
 *
 * ## Three things here are load-bearing
 *
 * **`emailVerified` is set.** Not decoration. `linkVerifiedOAuthIdentity` in
 * `lib/mobile-auth.ts` treats an *unverified* password account as a squatter:
 * if Google signs in with the same address, it takes the account over and
 * **nulls the password**. A reviewer idly tapping "Continue with Google" would
 * silently destroy the credential they were given, mid-review, with no error.
 * Setting this sends that logic down its harmless branch. It also means the
 * account survives an `emailVerified` gate if one is ever added to signin.
 *
 * **The profile is onboarded.** Otherwise the reviewer lands in an eight-step
 * onboarding flow that is hard-gated with no back button, and reviews the wrong
 * thing. Note in App Review Notes that onboarding is reachable by signing up
 * fresh.
 *
 * **There is an event.** An empty Events tab reads as a broken app, and that is
 * a likelier rejection than anything about authentication. One is created only
 * if nothing upcoming exists, so this stays a no-op on a populated database.
 */
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { occurrencesForSpan } from "../lib/occurrences"
import { checkPassword } from "../lib/password"
import { syncOccurrences } from "../lib/occurrences"

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

/** Where the demo event sits. Bengaluru — the launch city. */
const CITY = {
  name: "Bengaluru",
  state: "Karnataka",
  country: "India",
  latitude: 12.9721,
  longitude: 77.5938,
  timezone: "Asia/Kolkata",
}

async function main() {
  const email = process.env.APP_REVIEW_EMAIL?.trim().toLowerCase()
  const password = process.env.APP_REVIEW_PASSWORD

  if (!email || !email.includes("@") || !password) {
    console.error("usage: APP_REVIEW_EMAIL=... APP_REVIEW_PASSWORD=... npx tsx scripts/seed-review-account.ts")
    process.exit(1)
  }

  /*
   * The same rule the signup route enforces, checked here so a password that
   * cannot be reset later is rejected now rather than discovered by a reviewer.
   *
   * Worth knowing before you pick one: `lib/password.ts` blocklists the stem
   * `blendn` and strips trailing digits, so `Blendn12345!` is refused.
   */
  const check = checkPassword(password, email)
  if (!check.ok) {
    console.error(`APP_REVIEW_PASSWORD rejected: ${check.message}`)
    process.exit(1)
  }

  const hashed = await bcrypt.hash(password, 12)

  const user = await db.user.upsert({
    where: { email },
    update: {
      password: hashed,
      // Re-assert on every run: if a Google link cleared these between runs,
      // this is what puts the account back into a signable-in state.
      emailVerified: new Date(),
      deletedAt: null,
      suspended_at: null,
    },
    create: {
      email,
      name: "Alex Reviewer",
      password: hashed,
      emailVerified: new Date(),
      role: "attendee",
    },
  })

  await db.profiles.upsert({
    where: { id: user.id },
    update: { onboarded: true },
    create: {
      id: user.id,
      name: "Alex Reviewer",
      age: 29,
      location: CITY.name,
      bio: "Reviewing the app. Here for the music and the food.",
      onboarded: true,
    },
  })

  /*
   * A few interests, so match cards have something to say. Leaf categories
   * only — an overlap on a parent like "Music" is one half the room shares and
   * says nothing.
   */
  const leaves = await db.categories.findMany({
    where: { parent_id: { not: null } },
    take: 5,
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  })
  if (leaves.length > 0) {
    await db.user_interests.createMany({
      data: leaves.map((c) => ({ user_id: user.id, category_id: c.id })),
      skipDuplicates: true,
    })
  }

  // Only if the reviewer would otherwise see an empty Events tab.
  const upcoming = await db.events.count({
    where: { status: "published", end_time: { gte: new Date() } },
  })

  let eventNote = `${upcoming} upcoming event(s) already published — none created`
  if (upcoming === 0) {
    /*
     * The organiser cannot be the review account: it is an attendee, and an
     * attendee owning an event is a state nothing else in the product produces.
     * Reuse a real organiser if one exists, otherwise make a dedicated one.
     */
    const organizer =
      (await db.user.findFirst({ where: { role: { not: "attendee" } }, orderBy: { createdAt: "asc" } })) ??
      (await db.user.create({
        data: { email: `demo-organiser@${email.split("@")[1]}`, name: "Blend'n Demo", role: "organizer" },
      }))

    const start = new Date(Date.now() + 26 * 60 * 60 * 1000)
    const event = await db.events.create({
      data: {
        slug: `review-demo-event-${start.toISOString().slice(0, 10)}`,
        title: "Rooftop Sessions: Live Set",
        description:
          "An evening of live music on a rooftop in the city centre. Doors at 7, first set at 8. " +
          "Check in when you arrive to see who else is here.",
        short_description: "Live music, rooftop, city centre",
        latitude: CITY.latitude,
        longitude: CITY.longitude,
        address: `MG Road, ${CITY.name}`,
        venue_name: "The Rooftop",
        city: CITY.name,
        state: CITY.state,
        country: CITY.country,
        start_time: start,
        end_time: new Date(start.getTime() + 4 * 60 * 60 * 1000),
        timezone: CITY.timezone,
        status: "published",
        visibility: "public",
        max_capacity: 120,
        organizer_id: organizer.id,
        check_in_radius: 150,
      },
    })

    /*
     * Occurrences, or nobody can check in.
     *
     * `resolveOccurrence` returns `none` for an event with no occurrence rows,
     * and the check-in route reads `none` as `too_late` — "Event has already
     * ended", however far in the future the event sits. Reusing the product's
     * own writer rather than inserting rows keeps this fixture honest; a
     * fixture that hand-rolls what production computes is a second
     * implementation and will drift.
     */
    await syncOccurrences(event.id, start, new Date(start.getTime() + 4 * 60 * 60 * 1000), "Asia/Kolkata")

    /*
     * Without this, App Review cannot check in to the account we built for
     * them.
     *
     * `event_check_ins.occurrence_id` is NOT NULL, and `resolveOccurrence`
     * returns `none` for an event with no occurrence rows — which the check-in
     * route reports as **"Event has already ended"**, on an event starting
     * tomorrow. The reviewer would tap the one button the app is for and be
     * told the event is over.
     *
     * Every event created through the dashboard gets its occurrences from
     * `syncOccurrences`; this script wrote the `events` row directly and
     * skipped it. Nothing in a unit test could catch that, because the failure
     * is a missing row rather than a wrong one.
     */
    const days = occurrencesForSpan(event.start_time, event.end_time, event.timezone)
    await db.event_occurrences.createMany({
      data: days.map((d) => ({
        event_id: event.id,
        occurs_on: d.occursOn,
        start_time: d.startTime,
        end_time: d.endTime,
      })),
    })
    eventNote =
      `created "${event.title}" (${event.id}) starting ${event.start_time.toISOString()}` +
      ` — ${days.length} occurrence(s)`
  }

  console.log("Review account ready.")
  console.log(`  email         ${email}`)
  console.log(`  user id       ${user.id}`)
  console.log(`  emailVerified ${user.emailVerified?.toISOString() ?? "NOT SET — investigate"}`)
  console.log(`  onboarded     true (reviewer lands on the events tab, not onboarding)`)
  console.log(`  interests     ${leaves.length} leaf categories`)
  console.log(`  events        ${eventNote}`)
  console.log("\nPut these credentials in App Store Connect → App Review Information → Sign-In Information.")
}

main()
  .catch((e) => {
    console.error("Error:", e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
