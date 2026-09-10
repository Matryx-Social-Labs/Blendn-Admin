/**
 * Which marks a row carries, and in what order.
 *
 * ## Data, not JSX — and that is the point
 *
 * This lived inside `app/dashboard/onboarding/queue.tsx` and returned rendered
 * icons, so testing the ORDER meant parsing a client component through Jest,
 * which fails on the icon package's ESM. The ordering is the part that breaks
 * silently — every individual badge still looks right when the sequence is
 * wrong — so it is the part that most needs a direct test.
 *
 * The icon is a name here and the component maps it. Presentation stays in the
 * component; the judgement about what outweighs what is here, where it can be
 * asserted in four lines.
 */
export type EvidenceWeight = "against" | "for" | "state" | "neutral"
export type EvidenceIcon = "alert-triangle" | "mail-question" | "circle-check"

export interface EvidenceMark {
  key: string
  weight: EvidenceWeight
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
  icon?: EvidenceIcon
}

/**
 * Heaviest first.
 *
 * `against` is a reason to refuse, `for` is a credential, `state` and `neutral`
 * are context. The order is the mechanism rather than decoration: an admin
 * scanning seven rows reads down the LEFT EDGE of the badge column, so the
 * heaviest mark has to be leftmost or the scan reads the wrong thing.
 *
 * The badges used to render in a fixed sequence — role, email state, domain —
 * which put the strongest mark on a row in third place. Found by building the
 * screen in HTML before changing it: the colour fix alone looked right on one
 * row and wrong in a column.
 */
const WEIGHT_ORDER: Record<EvidenceWeight, number> = {
  against: 0,
  for: 1,
  state: 2,
  neutral: 3,
}

export function evidenceMarks(
  row: {
    roleLabel: string
    emailDomain: string | null
    freeProvider: boolean
    aggregatorDomain: boolean
  },
  awaitingEmail: boolean
): EvidenceMark[] {
  const marks: EvidenceMark[] = [
    { key: "role", weight: "neutral", label: row.roleLabel, variant: "secondary" },
    {
      key: "email",
      weight: "state",
      label: awaitingEmail ? "Email unconfirmed" : "Email confirmed",
      variant: "outline",
      icon: awaitingEmail ? "mail-question" : "circle-check",
    },
  ]

  if (row.aggregatorDomain) {
    /*
     * A company address is normally evidence somebody belongs to the
     * organisation, which is why the gate accepts one as-is. At a ticketing
     * platform that argument inverts: it proves they work at BookMyShow, and
     * the events being claimed are not BookMyShow's. The curated-events design
     * states the stake — without this, one such address could claim every event
     * on the platform.
     */
    marks.push({
      key: "aggregator",
      weight: "against",
      label: `Ticketing platform · ${row.emailDomain}`,
      variant: "destructive",
      icon: "alert-triangle",
    })
  } else if (row.freeProvider) {
    marks.push({ key: "provider", weight: "neutral", label: "Personal email", variant: "outline" })
  } else if (row.emailDomain) {
    marks.push({ key: "domain", weight: "for", label: row.emailDomain, variant: "default" })
  }

  return marks.sort((a, b) => WEIGHT_ORDER[a.weight] - WEIGHT_ORDER[b.weight])
}
