import { badgeFactsFor } from "@/lib/matches"
import { badgesFor, type Badge } from "@/lib/overlaps"

/**
 * The badges on a profile (Flow 6): what check-ins earned, derived on read and
 * never stored, by the same rule a match card uses (`badgesFor`).
 *
 * Without an event there is no venue, so "Regular here" never appears: it is
 * about the room both people are standing in, and a profile has none. What is
 * left is "N+ nights this month" and, for someone who turned it on, "Shows up".
 *
 * The caller decides whether to ask at all: `profiles.show_badges` off is none.
 */
export async function profileBadges(userId: string, showsUpOptIn: boolean): Promise<Badge[]> {
  const facts = await badgeFactsFor(null, [userId], showsUpOptIn ? [userId] : [])
  return badgesFor(facts(userId))
}
