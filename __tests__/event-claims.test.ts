import { readFileSync } from "fs"
import { join } from "path"
import { eventHost, PLATFORM_HOST } from "@/lib/event-host"

/**
 * The claim is the acquisition: a curated event sits in a city doing its job,
 * the real organiser finds it, proves it, and takes it over — arriving on the
 * platform with an event that already has attendees.
 */

const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const ACTIONS = "lib/event-claim-actions.ts"

describe("filing a claim", () => {
  const src = code(ACTIONS)

  it("does not require an account", () => {
    /*
     * Most claims arrive from somebody with no account — that is *why* the
     * event was curated. Requiring a login here would put a signup wall in
     * front of the acquisition funnel.
     *
     * Safe because filing proves nothing and grants nothing; a human reads it.
     *
     * This used to assert that `getAuth()` never appears. That was the right
     * intent pinned to the wrong fact, and it went stale the moment the session
     * became the ONLY acceptable source of an organisation id: the function
     * reads the session now, it just never *demands* one. So what is pinned is
     * the refusal — no `Forbidden`, no early return on a missing session.
     */
    const fileFn = /export async function fileEventClaim[\s\S]*?\n\}/.exec(src)
    expect(fileFn).not.toBeNull()
    expect(fileFn![0]).not.toMatch(/Forbidden/)
    expect(fileFn![0]).not.toMatch(/if \(!session/)
  })

  it("never takes the organisation from the caller", () => {
    /*
     * The eng review's second security finding. `orgId` used to arrive in the
     * input of an UNAUTHENTICATED action, so anyone who knew an organisation's
     * uuid could file a claim attributed to it — and the returned flags then
     * answered "does this address match that org's verified domains", which on
     * an open endpoint is an oracle.
     *
     * An `onboardingId` is still accepted, and the distinction is the point: a
     * pending application grants nothing, an organisation id names an owner
     * that already exists.
     */
    expect(src).toMatch(/interface FileClaimInput[\s\S]*?\n\}/)
    const iface = /interface FileClaimInput[\s\S]*?\n\}/.exec(src)![0]
    expect(iface).not.toMatch(/orgId/)
    expect(iface).toMatch(/onboardingId/)
    // The producer, not the consumer: the id has to come from `owningOrgFor`.
    expect(src).toMatch(/owningOrgFor\(session\.user\)/)
  })

  it("does not hand the flags back to an anonymous caller", () => {
    // Evidence for the reviewer, not feedback for the claimant. Telling someone
    // which signal they failed tells them what to forge next.
    expect(src).toMatch(/return \{ ok: true, claimId: claim\.id \}/)
    expect(src).not.toMatch(/return \{ ok: true, claimId: claim\.id, flags \}/)
  })

  it("rate-limits an endpoint nothing else bounds", () => {
    /*
     * Filing is unauthenticated by design, so the limiter is the only bound.
     * Three windows, because each alone is trivially sidestepped: vary the
     * address, and the IP catches it; use a proxy pool, and the per-event
     * bucket catches a flood aimed at one reviewer.
     */
    expect(src).toMatch(/overClaimLimit\(email, input\.eventId\)/)
    expect(src).toMatch(/rl:claim:email:/)
    expect(src).toMatch(/rl:claim:event:/)
    expect(src).toMatch(/rl:claim:ip:/)
    // Before the write, not after it.
    expect(src.indexOf("overClaimLimit(email")).toBeLessThan(src.indexOf("event_claims.create"))
  })

  it("insists on exactly one route in", () => {
    // A claim with neither has nothing to approve into; a claim with both is
    // two answers to one question. The DB has a CHECK; this is the message.
    expect(src).toMatch(/Boolean\(orgId\) === Boolean\(input\.onboardingId\)/)
  })

  it("uses the same refusal gate the read path uses", () => {
    /*
     * So the form and the submit cannot disagree — which is the failure the
     * chat write path spent a whole workstream on: GET said yes, POST said no.
     */
    expect(src).toMatch(/claimRefusal\(event\)/)
  })

  it("counts prior claims rather than upserting over them", () => {
    expect(src).toMatch(/db\.event_claims\.count\(\{ where: \{ event_id: event\.id \} \}\)/)
    expect(src).not.toMatch(/event_claims\.upsert/)
  })

  it("reads DNS-verified domains, not merely matching addresses", () => {
    /*
     * Decision 3a. `organisation_domains` stores DNS-TXT-verified, apex-only
     * domains with a global unique — so a domain check can mean *this org
     * proved control*, which is much harder to fake for the same effort.
     */
    expect(src).toMatch(/organisation_domains\.findMany/)
    expect(src).toMatch(/verified_at: \{ not: null \}/)
  })
})

describe("deciding one", () => {
  const src = code(ACTIONS)

  it("is app_admin only", () => {
    expect(src).toMatch(/session\?\.user\?\.role !== "app_admin"/)
  })

  it("re-checks claimability at decision time, not only at filing", () => {
    /*
     * A claim can sit in the queue for days. In that time the event can start,
     * or somebody else's claim can be approved. Trusting the filing-time check
     * is how an approval lands in the middle of a live event.
     */
    const decide = src.slice(src.indexOf("export async function decideEventClaim"))
    expect(decide).toMatch(/claimRefusal\(claim\.event\)/)
  })

  it("approves with one column write", () => {
    /*
     * Every screen unlocks from this, because `eventPermissions` already reads
     * `organizer_org_id`. That is the strongest argument for representing
     * curation this way rather than with a separate table.
     */
    expect(src).toMatch(/organizer_org_id: orgId, claimed_at: new Date\(\)/)
  })

  it("never rewrites organizer_id", () => {
    /*
     * CLAUDE.md: it records who CREATED the row, and after a claim that is
     * still true — the platform did. Rewriting it destroys the only record that
     * this event was curated rather than filed, which is the fact a later
     * dispute turns on.
     */
    const decide = src.slice(src.indexOf("export async function decideEventClaim"))
    expect(decide).not.toMatch(/organizer_id:/)
  })

  it("supersedes the losers rather than declining them", () => {
    /*
     * `declined` is a judgement about the claimant and reaches them as one. A
     * claim that lost a race deserves a different word, and a reviewer reading
     * the queue later needs to tell the two apart.
     */
    expect(src).toMatch(/status: "superseded"/)
  })

  it("refuses to approve a claim with no organisation to hand it to", () => {
    expect(src).toMatch(/Approve their application first/)
  })

  it("takes the organisation from the approved application when the claim has none", () => {
    /*
     * A no-account claim carries `onboarding_id`; approving that application
     * creates the organisation on the request and nothing wrote it back to the
     * claim, so the hand-over refused for ever. Found by handing over the
     * seeded no-account claim after the flag copy had promised it would work.
     */
    const decide = src.slice(src.indexOf("export async function decideEventClaim"))
    expect(decide).toMatch(/organiser_onboarding_requests\.findUnique\(\{[\s\S]*?where: \{ id: claim\.onboarding_id \}/)
    expect(decide).toMatch(/claim\.org_id \?\?/)
    // And it is recorded on the claim, so the row says who got the event.
    // …and `event_claims_one_claimant` wants exactly one of the pair set.
    expect(decide).toMatch(/\{ org_id: orgId, onboarding_id: null \}/)
  })

  it("makes the write and the supersede one transaction", () => {
    // Half of this is worse than none: an event handed over while three other
    // claims still say pending is a queue that contradicts the event.
    expect(src).toMatch(/db\.\$transaction\(async \(tx\) => \{/)
  })
})

describe("who to show as the host", () => {
  it("shows the owning organisation once a claim lands", () => {
    expect(eventHost({
      curated_at: new Date(),
      organizer_org: { display_name: "The Humming Tree" },
      organizer: { name: "An Admin" },
    })).toEqual({ name: "The Humming Tree", isPlatform: false })
  })

  it("never shows the curating admin's name on a public card", () => {
    /*
     * The admin who ran the curation is not the host. Putting their name on a
     * card would be wrong AND a small privacy leak — the one place a founder's
     * real name would appear on an attendee-facing surface.
     */
    const host = eventHost({
      curated_at: new Date(),
      organizer_org: null,
      organizer: { name: "Sagar" },
    })
    expect(host.name).toBe(PLATFORM_HOST)
    expect(host.isPlatform).toBe(true)
  })

  it("shows the creating user for an event that predates organisations", () => {
    expect(eventHost({
      curated_at: null, organizer_org: null, organizer: { name: "Priya" },
    })).toEqual({ name: "Priya", isPlatform: false })
  })

  it("tells the client when it is the platform standing in", () => {
    // A curated listing should say where it came from and offer the claim; an
    // organiser's event should not.
    expect(eventHost({ curated_at: new Date(), organizer_org: null, organizer: null }).isPlatform)
      .toBe(true)
  })
})

/**
 * Two things the engineering review found, both of which passed every existing
 * test because both are absences.
 */
describe("the host resolver is actually wired to something", () => {
  /*
   * `lib/event-host.ts` was written, tested, and imported by NOTHING.
   *
   * Its own docstring says putting the curating admin's name on a public card
   * "would be both wrong and a small privacy leak -- it is the one place a
   * founder's real name would appear on an attendee-facing surface." That leak
   * was live: `events.service.ts` selected `organizer: { id, name, image }`,
   * which for a curated event is the ADMIN who ran the curation, and
   * `EventDetailScreen.tsx:258` renders `d.organizer?.name`.
   *
   * This is A1-A7's dominant theme -- a correct mechanism with no input -- and
   * nothing caught it because `server-actions-reachable` only scans `lib/`
   * modules beginning with `"use server"`, which this one does not.
   */
  const service = code("lib/services/events.service.ts")

  it("the mobile payload resolves the host rather than passing the creator through", () => {
    expect(service).toMatch(/import \{ eventHost \} from "@\/lib\/event-host"/)
    expect(service).toMatch(/eventHost\(event\)/)
    // The producer, not just the consumer: pinning only `organizer:` would pass
    // against a version that assigned `event.organizer` straight back.
    expect(service).not.toMatch(/organizer: event\.organizer,/)
  })

  it("the detail route resolves the host too — it is the screen an attendee reads", () => {
    // The list was fixed (T83) and this route still passed `event.organizer`
    // through, so `EventDetailScreen` showed the curating admin's real name
    // on every curated event. Found by reading one event through both routes.
    const detail = code("app/api/mobile/events/[eventId]/route.ts")
    expect(detail).toMatch(/import \{ eventHost \} from "@\/lib\/event-host"/)
    expect(detail).toMatch(/eventHost\(event\)/)
    expect(detail).not.toMatch(/organizer: event\.organizer,/)
    expect(detail).toMatch(/organizer_org: \{ select: \{ display_name: true \} \}/)
  })

  it("selects the columns the resolver needs", () => {
    // `...eventHostSelect` cannot be spread here -- it claims `organizer` too,
    // with a narrower shape, and would silently drop `id`/`image`. So the
    // columns are named, and they have to stay named.
    expect(service).toMatch(/curated_at: true/)
    expect(service).toMatch(/organizer_org: \{ select: \{ display_name: true \} \}/)
  })

  it("never shows the curating admin", () => {
    const curated = eventHost({
      curated_at: new Date(),
      organizer_org: null,
      organizer: { name: "Sagar Kishore Kumar" },
    })
    expect(curated.name).toBe(PLATFORM_HOST)
    expect(curated.isPlatform).toBe(true)
  })
})

describe("two admins cannot both approve", () => {
  /*
   * H13, closed rather than inherited.
   *
   * `decideEventClaim` re-reads `claimRefusal` before its transaction, and a
   * read outside a transaction is not a lock: two admins with the queue open
   * both see `claimed_at IS NULL`, both pass, and both commit. The result is
   * two rows saying `approved`, an event owned by whichever transaction
   * committed last, and a second organisation told they got it.
   */
  it("has a partial unique on approved claims", () => {
    const sql = readFileSync(
      join(ROOT, "prisma/migrations/20260824140000_one_approved_claim/migration.sql"),
      "utf8"
    )
    expect(sql).toMatch(/CREATE UNIQUE INDEX "event_claims_one_approved_per_event"/)
    expect(sql).toMatch(/ON "event_claims" \("event_id"\)/)
    expect(sql).toMatch(/WHERE "status" = 'approved'/)
  })

  it("turns the loser's constraint violation into the right sentence", () => {
    const src = code(ACTIONS)
    expect(src).toMatch(/event_claims_one_approved_per_event/)
    expect(src).toMatch(/Somebody else's claim was approved first\./)
  })

  it("wraps the transaction, not just the pre-check", () => {
    // The catch has to sit around `$transaction`. A catch around only the
    // pre-check would be the bug wearing a handler.
    const src = code(ACTIONS)
    const guarded = /try \{\s*await db\.\$transaction/
    expect(src).toMatch(guarded)
  })
})

describe("the funnel has an entry", () => {
  /*
   * The eng review's scope finding, pinned so it cannot silently regress.
   *
   * `fileEventClaim` existed with ZERO callers and no page filed a claim. The
   * admin half of W5 was complete -- queue, flags, decide, audit -- and the
   * queue it reads could never fill. The venue queue has had a filing page
   * since it shipped; the event queue did not.
   */
  it("has a public claim page that calls the action", () => {
    const page = code("app/claim/[eventId]/claim-form.tsx")
    expect(page).toMatch(/fileEventClaim\(\{/)
  })

  it("that page is outside every middleware guard", () => {
    /*
     * The person this page is for has no account -- that is *why* the event was
     * curated. `middleware.ts` matches `/`, `/login`, `/dashboard/*` and
     * `/api/mobile/*`; adding `/claim` to any of them would put a sign-in in
     * front of the sign-up funnel.
     */
    const mw = code("middleware.ts")
    expect(mw).not.toMatch(/["']\/claim/)
  })

  it("the mobile payload carries the link, and drops it once claimed", () => {
    const svc = code("lib/services/events.service.ts")
    expect(svc).toMatch(/claimUrl:/)
    expect(svc).toMatch(/event\.curated_at && !event\.claimed_at/)
  })

  it("does not reuse the onboarding writer, it calls the one that exists", () => {
    /*
     * `POST /api/onboarding/apply` stays the only writer of
     * `organiser_onboarding_requests` -- it owns the duplicate check, the tier,
     * the email token and the verification mail. A second writer for one
     * concept is the shape of half this codebase's audit.
     */
    const form = code("app/claim/[eventId]/claim-form.tsx")
    expect(form).toMatch(/\/api\/onboarding\/apply/)
    expect(form).not.toMatch(/organiser_onboarding_requests/)
  })
})
