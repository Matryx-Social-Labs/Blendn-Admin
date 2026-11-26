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
 * **There is an event the reviewer can enter.** One, by the fixed slug
 * `review-demo-event`, made or moved on every run (launch gate 6, SCRUM-1196).
 * Unlisted, so no feed or search shows it to real users; the reviewer opens it
 * from the link printed below, pasted into the App Review notes. Open around
 * the clock for a week from the run, because a review takes days and the
 * reviewer is not in Bengaluru (the geofence half is `REVIEW_ACCOUNT_IDS`).
 */
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { checkPassword } from "../lib/password"
import { closeDb } from "../lib/db"
import { syncOccurrences } from "../lib/occurrences"
import { eventShareUrl } from "../lib/event-share"
import { realEventsWhere } from "../lib/event-kind"

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

/** The review event's one row: found by this on every run, never a second. */
const REVIEW_DEMO_SLUG = "review-demo-event"

/** Where the demo event sits. Bengaluru — the launch city. */
const CITY = {
  name: "Bengaluru",
  state: "Karnataka",
  country: "India",
  latitude: 12.9721,
  longitude: 77.5938,
  timezone: "Asia/Kolkata",
}

function refuse(message: string): never {
  console.error(message)
  process.exit(1)
}

async function main() {
  const email = process.env.APP_REVIEW_EMAIL?.trim().toLowerCase()
  const password = process.env.APP_REVIEW_PASSWORD

  // An unset DATABASE_URL would fall through to whatever PG* variables the shell has.
  if (!email || !email.includes("@") || !password || !process.env.DATABASE_URL) {
    refuse("usage: APP_REVIEW_EMAIL=... APP_REVIEW_PASSWORD=... DATABASE_URL=... npx tsx scripts/seed-review-account.ts")
  }

  /*
   * The same rule the signup route enforces, checked here so a password that
   * cannot be reset later is rejected now rather than discovered by a reviewer.
   *
   * Worth knowing before you pick one: `lib/password.ts` blocklists the stem
   * `blendn` and strips trailing digits, so `Blendn12345!` is refused.
   */
  const check = checkPassword(password, email)
  if (!check.ok) refuse(`APP_REVIEW_PASSWORD rejected: ${check.message}`)

  // The upsert below resets the password of whoever has this address: never a staff account's.
  const holder = await db.user.findUnique({ where: { email }, select: { role: true } })
  if (holder && holder.role !== "attendee") refuse(`APP_REVIEW_EMAIL belongs to a ${holder.role} account: use a new address`)

  /*
   * Who the review event is filed under. Not the review account: it is an
   * attendee, and an attendee owning an event is a state nothing else in the
   * product produces. The oldest active organiser or admin, re-asserted on
   * every run, because the event's public page is hidden while its host is
   * suspended or deleted (`hostPersonActive`, lib/share-public.ts) and the
   * printed link would open nothing. No account is invented for it: one with
   * a password nobody holds, at a domain nobody checked, is a takeover.
   */
  const organizer = await db.user.findFirst({
    where: { role: { in: ["organizer", "app_admin"] }, suspended_at: null, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  })
  if (!organizer) refuse("No active organizer or app_admin account to file the review event under: create one first")

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

  const { event, occurrences } = await upsertReviewDemoEvent(organizer.id)

  console.log("Review account ready.")
  console.log(`  email         ${email}`)
  console.log(`  user id       ${user.id}`)
  console.log(`  App Review aid: set REVIEW_ACCOUNT_IDS=${user.id} on the server to turn it on for this account (DEPLOYMENT.md § 7)`)
  console.log(`  emailVerified ${user.emailVerified?.toISOString() ?? "NOT SET — investigate"}`)
  console.log(`  onboarded     true (reviewer lands on the events tab, not onboarding)`)
  console.log(`  interests     ${leaves.length} leaf categories`)
  console.log(`  review event  "${event.title}" (${event.id}), unlisted, ${occurrences} daily session(s)`)
  console.log(`                door open ${event.start_time.toISOString()} to ${event.end_time.toISOString()}`)
  console.log(`  share link    ${eventShareUrl(event.id)}`)
  console.log("\nPut these credentials, and the share link, in App Store Connect → App Review Information.")
  console.log("Run it again on submission day: the week starts from the run.")
}

if (require.main === module) {
  main()
  .catch((e) => {
    console.error("Error:", e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
    // `syncOccurrences` writes through the app's own pool; left open, the script never exits.
    await closeDb()
  })
}

/**
 * The review event, by its fixed slug: created on the first run, its window
 * moved to start now on every later one.
 *
 * The end's clock time is what keeps the door open all week.
 * `syncOccurrences` cuts a span into daily sessions, each from the start's
 * clock time to the end's, rolled into the next day when the end's is not
 * later. "Now − 1 h to now + 7 d" ends an hour after the start's clock: every
 * day after the first is a one-hour session and the door is shut 156 hours of
 * the week. Ending one minute short of seven days runs each session into the
 * next day's (the 90-minute door lead covers the seam) and leaves no sliver of
 * a last day.
 */
async function upsertReviewDemoEvent(organizerId: string) {
  const start = new Date(Date.now() - 60 * 60 * 1000)
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 60 * 1000)
  const window = {
    start_time: start,
    end_time: end,
    status: "published" as const,
    visibility: "unlisted" as const,
    deleted_at: null,
    organizer_id: organizerId,
  }
  /*
   * Only a row this script made is ever moved. `review_demo` has no other
   * writer, and an organiser who titles an event "Review Demo Event" gets this
   * slug: rewriting theirs would publish it, unlist it and hand it the bypass.
   */
  const existing = await db.events.findUnique({ where: { slug: REVIEW_DEMO_SLUG }, select: { id: true, review_demo: true } })
  if (existing && !existing.review_demo) {
    throw new Error(`the slug ${REVIEW_DEMO_SLUG} belongs to an event this script did not make (${existing.id}): nothing written`)
  }
  // One review event: the dated rows of earlier runs lose the bypass (old ones are public).
  await db.events.updateMany({ where: { ...realEventsWhere, review_demo: true, slug: { not: REVIEW_DEMO_SLUG } }, data: { review_demo: false } })
  const event = existing
    ? await db.events.update({ where: { id: existing.id }, data: window })
    : await db.events.create({
        data: {
          ...window,
          slug: REVIEW_DEMO_SLUG,
          // A REVIEW_ACCOUNT_IDS account may check in here from anywhere (lib/review-accounts.ts).
          review_demo: true,
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
          timezone: CITY.timezone,
          max_capacity: 120,
          check_in_radius: 150,
        },
      })

  /*
   * Occurrences, or nobody can check in.
   *
   * `resolveOccurrence` returns `none` for an event with no occurrence rows,
   * and the check-in route reads `none` as `too_late` — "Event has already
   * ended", however far in the future the event sits. The product's own writer,
   * so a re-run keeps a day's row (and its check-ins) and drops the days the
   * window has left. A hand-rolled insert next to it broke
   * @@unique(event_id, occurs_on) once (SCRUM-976).
   */
  await syncOccurrences(event.id, start, end, CITY.timezone)
  // `syncOccurrences` keeps a day's row as it was, so a day somebody called off stays off: the week is all on.
  await db.event_occurrences.updateMany({
    where: { event_id: event.id, start_time: { gte: start }, cancelled_at: { not: null } },
    data: { cancelled_at: null },
  })
  const occurrences = await db.event_occurrences.count({ where: { event_id: event.id, cancelled_at: null } })
  return { event, occurrences }
}
