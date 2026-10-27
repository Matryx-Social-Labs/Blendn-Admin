/**
 * Who sells what the dashboard sells: the seller block every public policy
 * page ends with (Razorpay's website verification reads it, docs/RAZORPAY-VERIFICATION.md).
 *
 * The brand is Matrix Social Labs; on anything legal it is Matryx Social Labs
 * Private Limited — one company, two names, never two entities. The address,
 * phone and email are the ones the Terms of Use (docs/legal/terms-of-use.html)
 * already publish. Pure and client-safe.
 */
export const COMPANY = {
  brand: "Matrix Social Labs",
  legalName: "Matryx Social Labs Private Limited",
  address:
    "No 12, 11th Cross, near Kittur Rani Chennamma Road, Bendre Nagar, Banashankari 2nd Stage, Bangalore South, Bengaluru, Karnataka 560070, India",
  email: "contact@matrixsociallabs.com",
  phone: "+91 81972 83344",
  phoneHref: "tel:+918197283344",
  privacyEmail: "privacy@blendn.app",
  grievance: { name: "Likhith Gowda", title: "Chief Operating Officer", email: "grievance@blendn.app" },
  /** The current privacy policy, the one the app links to (the landing site's). */
  privacyUrl: "https://www.blendn.app/privacy",
} as const

/** The public policy pages, in the order every page and the sign-in page list them. */
export const POLICY_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refunds", label: "Cancellation & refunds" },
  { href: "/shipping", label: "Shipping & delivery" },
] as const

export type PolicyPath = (typeof POLICY_LINKS)[number]["href"]
