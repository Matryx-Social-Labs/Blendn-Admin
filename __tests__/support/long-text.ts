/**
 * The worst-case strings every redesign is proofed with (owner, 2026-11-05): the same list as the client's
 * `__tests__/helpers/longText.ts`. Only data-driven text: names, titles, venues, counts, prices. Static copy is designed in
 * place. Dashboards and money keep full numbers.
 */
export const WORST = {
  city: "Thiruvananthapuram",
  cityHyphenated: "Saint-Jean-sur-Richelieu",
  eventTitle: "Midnight Bass: a four-deck takeover with special guests from Berlin and Bengaluru",
  venue: "The Courtyard at Jayamahal Palace Hotel",
  firstName: "Venkatalakshmi",
  firstNameHyphenated: "Maximilian-Alexander",
  firstNameDevanagari: "वेंकटलक्ष्मी",
  count: 12_480,
  bigCount: 1_240_000,
  inrMinor: 1_249_900,
  cadMinor: 124_999,
  ticketType: "Early bird · Standing · Includes one drink",
  ticketTypeDevanagari: "वीआईपी लाउंज · Reserved table for six with bottle service",
} as const
