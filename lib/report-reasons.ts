/**
 * Every report reason, in one list (D-027, D-032).
 *
 * `severity` is the order a reviewer takes reports in (S1 first). `urgent`
 * marks the four reasons D-032 names: an intimate image shared without consent,
 * impersonation, somebody under 18, and child safety. `suspension` is what a
 * person suspended on a report of this reason reads after "Reason:"
 * (`SUSPENSION_CATEGORIES`, lib/suspension.ts); null reads as breaking our
 * community guidelines.
 *
 * The routes store a report's `reason` as the app sent it, so a free string from
 * an older app keeps its words; `reportReason` reads any stored value as one of
 * these, and anything unknown as `other`.
 *
 * Values the installed app sends: a person and Unmatch/Block and report
 * (harassment, inappropriate_messages, inappropriate_photos, fake_profile, spam,
 * other), a message and the Lobby (harassment, hate_speech, inappropriate_content,
 * spam, other), an event (misleading_listing, unsafe_venue, organiser_conduct,
 * not_real, other), a room (pile_on, hate_speech, unsafe, host_conduct, spam,
 * other), a crew (spam, offensive, contact_details, impersonation, other) and an
 * offer (offensive, misleading, spam, unsafe, other).
 */
export const REPORT_REASONS = {
  child_safety: { severity: "S1", urgent: true, suspension: null },
  intimate_image: { severity: "S1", urgent: true, suspension: null },
  under_18: { severity: "S1", urgent: true, suspension: null },
  impersonation: { severity: "S1", urgent: true, suspension: null },
  threat: { severity: "S1", urgent: false, suspension: null },
  unsafe: { severity: "S1", urgent: false, suspension: null },
  harassment: { severity: "S2", urgent: false, suspension: "harassment" },
  hate_speech: { severity: "S2", urgent: false, suspension: "hate speech" },
  pile_on: { severity: "S2", urgent: false, suspension: null },
  inappropriate_content: { severity: "S2", urgent: false, suspension: "inappropriate content" },
  inappropriate_messages: { severity: "S2", urgent: false, suspension: "inappropriate messages" },
  inappropriate_photos: { severity: "S2", urgent: false, suspension: "inappropriate photos" },
  offensive: { severity: "S2", urgent: false, suspension: null },
  fake_profile: { severity: "S2", urgent: false, suspension: "a fake profile" },
  host_conduct: { severity: "S2", urgent: false, suspension: null },
  organiser_conduct: { severity: "S2", urgent: false, suspension: null },
  unsafe_venue: { severity: "S2", urgent: false, suspension: null },
  spam: { severity: "S3", urgent: false, suspension: "spam" },
  contact_details: { severity: "S3", urgent: false, suspension: null },
  misleading: { severity: "S3", urgent: false, suspension: null },
  misleading_listing: { severity: "S3", urgent: false, suspension: null },
  not_real: { severity: "S3", urgent: false, suspension: null },
  other: { severity: "S3", urgent: false, suspension: null },
} as const satisfies Record<string, { severity: "S1" | "S2" | "S3"; urgent: boolean; suspension: string | null }>

export type ReportReason = keyof typeof REPORT_REASONS

/** A stored reason as one of the list (trimmed, any case); anything else is `other`. */
export function reportReason(stored: string | null | undefined): ReportReason {
  const key = stored?.trim().toLowerCase() ?? ""
  return Object.hasOwn(REPORT_REASONS, key) ? (key as ReportReason) : "other"
}
