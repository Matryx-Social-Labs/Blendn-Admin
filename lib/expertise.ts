import { WORK_FIELDS } from "@/lib/work-fields"

/**
 * What someone does *within* their field.
 *
 * The Grid card's frame (`1141:4951`) draws two tags under the name — "Spatial
 * Web", "LLM Architecture", "UX Psychology" — a level finer than `work_field`,
 * which is nineteen buckets ending in "Something else". Nothing in the product
 * backed them, so the card shipped without the row.
 *
 * ## Curated, because free text here is an address
 *
 * `work_field` exists to avoid exactly one thing, and its own file says it:
 *
 * > "works in design" is an attribute; "Principal Designer at Swiggy" is a way
 * > to find her on LinkedIn.
 *
 * A free-text expertise box is where somebody types their employer, their exact
 * title, or the conference talk they gave — on a roster where they are
 * pseudonymous. That is the leak `work_field` was built to prevent,
 * reintroduced one field lower. It is also unnormalisable ("ML", "Machine
 * Learning", "machine learning" never match) and therefore unfilterable, which
 * is the second lesson from `profiles.interests` being collected as free text
 * and costing two PRs to migrate.
 *
 * So: a list, served by the API, scoped to the field above it.
 *
 * ## Scoped, and the slugs carry their scope
 *
 * `design_ux_research`, not `ux_research`. Two reasons, and the second is the
 * one that matters:
 *
 * 1. Nothing collides. "Research" is a real specialism in six of these fields
 *    and means six different things.
 * 2. **A stored value can be checked against the field that owns it.** Somebody
 *    who switches from Design to Finance must not keep "UX Psychology" — a card
 *    reading *"Finance & Banking · Neuro-design"* is incoherent, and worse, it
 *    is a fossil of an attribute they changed. `pruneExpertise` below is called
 *    on every profile write for that reason.
 *
 * ## What is deliberately not here
 *
 * **No seniority.** "Principal", "Head of", "Lead" describe a rung, not a
 * subject, and a rung plus a field plus a city narrows a room fast.
 *
 * **No employer, product or team names.** Same rule as `work_field`.
 *
 * **No list for "Something else".** A bucket that exists precisely because the
 * taxonomy did not fit cannot then be sub-divided honestly, so it returns none
 * and the card simply omits the row — which is what `MAX_EXPERTISE`-and-nothing
 * looks like everywhere else.
 */

export interface Expertise {
  /**
   * Stored on the profile. Prefixed with its work field's slug, so a stored
   * value can be validated against the field without a second column.
   */
  slug: string
  /** What the app shows. Title case, because the card renders it as a tag. */
  label: string
}

/**
 * How many somebody may pick.
 *
 * Three, and the frame draws two. The card shows the first two and a profile
 * has room for the third — but the cap is what stops this becoming a résumé:
 * somebody who ticks nine specialisms has described a person, not an attribute,
 * and the whole point of the list is that a tag should fit several people.
 */
export const MAX_EXPERTISE = 3

/**
 * The specialisms, by work field.
 *
 * Eight to eleven each — the same reasoning as `WORK_FIELDS`' own eighteen:
 * few enough to scroll without a search box, coarse enough that a tag in a room
 * of fifty is plausibly shared. Finer is more informative and more identifying,
 * which is the wrong trade in a room whose premise is that nobody has to be
 * findable.
 */
export const EXPERTISE_BY_FIELD: Readonly<Record<string, readonly Expertise[]>> = {
  software: [
    { slug: "software_frontend", label: "Frontend" },
    { slug: "software_backend", label: "Backend" },
    { slug: "software_mobile", label: "Mobile" },
    { slug: "software_infrastructure", label: "Infrastructure & DevOps" },
    { slug: "software_security", label: "Security" },
    { slug: "software_embedded", label: "Embedded & Hardware" },
    { slug: "software_games", label: "Games" },
    { slug: "software_testing", label: "Testing & Quality" },
    { slug: "software_distributed", label: "Distributed Systems" },
    { slug: "software_devtools", label: "Developer Tools" },
  ],
  design: [
    { slug: "design_product", label: "Product Design" },
    { slug: "design_ux_research", label: "UX Research" },
    { slug: "design_brand", label: "Brand & Identity" },
    { slug: "design_motion", label: "Motion & Animation" },
    { slug: "design_systems", label: "Design Systems" },
    { slug: "design_illustration", label: "Illustration" },
    { slug: "design_service", label: "Service Design" },
    { slug: "design_spatial", label: "Spatial & Interiors" },
    { slug: "design_graphic", label: "Graphic Design" },
    { slug: "design_accessibility", label: "Accessibility" },
  ],
  product: [
    { slug: "product_management", label: "Product Management" },
    { slug: "product_growth", label: "Growth" },
    { slug: "product_analytics", label: "Product Analytics" },
    { slug: "product_platform", label: "Platform" },
    { slug: "product_ops", label: "Product Operations" },
    { slug: "product_program", label: "Program Management" },
    { slug: "product_marketing", label: "Product Marketing" },
    { slug: "product_discovery", label: "Research & Discovery" },
  ],
  data_ai: [
    { slug: "data_ai_machine_learning", label: "Machine Learning" },
    { slug: "data_ai_engineering", label: "Data Engineering" },
    { slug: "data_ai_science", label: "Data Science" },
    { slug: "data_ai_analytics", label: "Analytics" },
    { slug: "data_ai_mlops", label: "MLOps" },
    { slug: "data_ai_nlp", label: "Language & NLP" },
    { slug: "data_ai_vision", label: "Computer Vision" },
    { slug: "data_ai_research", label: "Research" },
    { slug: "data_ai_governance", label: "Data Governance" },
  ],
  finance: [
    { slug: "finance_investment_banking", label: "Investment Banking" },
    { slug: "finance_venture", label: "Venture Capital" },
    { slug: "finance_private_equity", label: "Private Equity" },
    { slug: "finance_retail_banking", label: "Retail Banking" },
    { slug: "finance_risk", label: "Risk & Compliance" },
    { slug: "finance_accounting", label: "Accounting & Audit" },
    { slug: "finance_planning", label: "Financial Planning" },
    { slug: "finance_insurance", label: "Insurance" },
    { slug: "finance_fintech", label: "Fintech" },
    { slug: "finance_markets", label: "Markets & Trading" },
  ],
  marketing: [
    { slug: "marketing_brand", label: "Brand Marketing" },
    { slug: "marketing_performance", label: "Performance Marketing" },
    { slug: "marketing_content", label: "Content & Copy" },
    { slug: "marketing_seo", label: "Search & SEO" },
    { slug: "marketing_social", label: "Social Media" },
    { slug: "marketing_events", label: "Events & Field" },
    { slug: "marketing_comms", label: "PR & Communications" },
    { slug: "marketing_analytics", label: "Marketing Analytics" },
    { slug: "marketing_creative", label: "Creative Direction" },
  ],
  sales: [
    { slug: "sales_enterprise", label: "Enterprise Sales" },
    { slug: "sales_inside", label: "Inside Sales" },
    { slug: "sales_solutions", label: "Solutions Engineering" },
    { slug: "sales_accounts", label: "Account Management" },
    { slug: "sales_partnerships", label: "Partnerships" },
    { slug: "sales_ops", label: "Sales Operations" },
    { slug: "sales_customer_success", label: "Customer Success" },
    { slug: "sales_bizdev", label: "Business Development" },
  ],
  operations: [
    { slug: "operations_supply_chain", label: "Supply Chain" },
    { slug: "operations_logistics", label: "Logistics" },
    { slug: "operations_procurement", label: "Procurement" },
    { slug: "operations_warehousing", label: "Warehousing" },
    { slug: "operations_manufacturing", label: "Manufacturing Operations" },
    { slug: "operations_quality", label: "Quality Assurance" },
    { slug: "operations_transport", label: "Fleet & Transport" },
    { slug: "operations_business", label: "Business Operations" },
  ],
  healthcare: [
    { slug: "healthcare_general_medicine", label: "General Medicine" },
    { slug: "healthcare_surgery", label: "Surgery" },
    { slug: "healthcare_nursing", label: "Nursing" },
    { slug: "healthcare_dentistry", label: "Dentistry" },
    { slug: "healthcare_mental_health", label: "Mental Health" },
    { slug: "healthcare_physiotherapy", label: "Physiotherapy" },
    { slug: "healthcare_pharmacy", label: "Pharmacy" },
    { slug: "healthcare_public_health", label: "Public Health" },
    { slug: "healthcare_research", label: "Medical Research" },
    { slug: "healthcare_diagnostics", label: "Diagnostics & Imaging" },
    { slug: "healthcare_veterinary", label: "Veterinary" },
  ],
  education: [
    { slug: "education_teaching", label: "Teaching" },
    { slug: "education_higher", label: "Higher Education" },
    { slug: "education_research", label: "Academic Research" },
    { slug: "education_curriculum", label: "Curriculum Design" },
    { slug: "education_edtech", label: "EdTech" },
    { slug: "education_training", label: "Training & Development" },
    { slug: "education_special", label: "Special Education" },
    { slug: "education_administration", label: "Administration" },
  ],
  law_policy: [
    { slug: "law_policy_corporate", label: "Corporate Law" },
    { slug: "law_policy_litigation", label: "Litigation" },
    { slug: "law_policy_ip", label: "Intellectual Property" },
    { slug: "law_policy_compliance", label: "Regulatory & Compliance" },
    { slug: "law_policy_public", label: "Public Policy" },
    { slug: "law_policy_human_rights", label: "Human Rights" },
    { slug: "law_policy_tax", label: "Tax" },
    { slug: "law_policy_ops", label: "Legal Operations" },
  ],
  media: [
    { slug: "media_journalism", label: "Journalism" },
    { slug: "media_editing", label: "Editing" },
    { slug: "media_broadcast", label: "Broadcast" },
    { slug: "media_documentary", label: "Documentary" },
    { slug: "media_photography", label: "Photography" },
    { slug: "media_publishing", label: "Publishing" },
    { slug: "media_audio", label: "Podcasting & Audio" },
    { slug: "media_content_strategy", label: "Content Strategy" },
  ],
  arts: [
    { slug: "arts_music", label: "Music" },
    { slug: "arts_film", label: "Film & Television" },
    { slug: "arts_theatre", label: "Theatre" },
    { slug: "arts_visual", label: "Visual Arts" },
    { slug: "arts_dance", label: "Dance" },
    { slug: "arts_writing", label: "Writing" },
    { slug: "arts_production", label: "Production" },
    { slug: "arts_talent", label: "Talent & Casting" },
    { slug: "arts_curation", label: "Curation" },
  ],
  hospitality: [
    { slug: "hospitality_culinary", label: "Culinary" },
    { slug: "hospitality_bar", label: "Bar & Beverage" },
    { slug: "hospitality_restaurant_ops", label: "Restaurant Operations" },
    { slug: "hospitality_hotels", label: "Hotels" },
    { slug: "hospitality_catering", label: "Events & Catering" },
    { slug: "hospitality_travel", label: "Travel & Tourism" },
    { slug: "hospitality_pastry", label: "Baking & Pastry" },
    { slug: "hospitality_front_of_house", label: "Front of House" },
  ],
  engineering: [
    { slug: "engineering_mechanical", label: "Mechanical" },
    { slug: "engineering_electrical", label: "Electrical" },
    { slug: "engineering_civil", label: "Civil" },
    { slug: "engineering_chemical", label: "Chemical" },
    { slug: "engineering_aerospace", label: "Aerospace" },
    { slug: "engineering_automotive", label: "Automotive" },
    { slug: "engineering_industrial_design", label: "Industrial Design" },
    { slug: "engineering_energy", label: "Energy" },
    { slug: "engineering_robotics", label: "Robotics" },
    { slug: "engineering_construction", label: "Construction" },
  ],
  consulting: [
    { slug: "consulting_strategy", label: "Strategy" },
    { slug: "consulting_management", label: "Management" },
    { slug: "consulting_technology", label: "Technology" },
    { slug: "consulting_financial", label: "Financial Advisory" },
    { slug: "consulting_people", label: "People & Culture" },
    { slug: "consulting_operations", label: "Operations" },
    { slug: "consulting_sustainability", label: "Sustainability" },
    { slug: "consulting_independent", label: "Independent" },
  ],
  government_ngo: [
    { slug: "government_ngo_administration", label: "Public Administration" },
    { slug: "government_ngo_development", label: "Development & Aid" },
    { slug: "government_ngo_environment", label: "Environment" },
    { slug: "government_ngo_social_work", label: "Social Work" },
    { slug: "government_ngo_diplomacy", label: "Diplomacy" },
    { slug: "government_ngo_defence", label: "Defence & Security" },
    { slug: "government_ngo_urban_planning", label: "Urban Planning" },
    { slug: "government_ngo_advocacy", label: "Advocacy" },
  ],
  /*
   * What you study, not what you do. The one field where the parallel list is a
   * different kind of thing — and it has to be, because "Student · Backend" is
   * a claim about a job that a student may not have.
   */
  student: [
    { slug: "student_engineering", label: "Engineering" },
    { slug: "student_computing", label: "Computing" },
    { slug: "student_business", label: "Business" },
    { slug: "student_sciences", label: "Sciences" },
    { slug: "student_humanities", label: "Humanities" },
    { slug: "student_social_sciences", label: "Social Sciences" },
    { slug: "student_medicine", label: "Medicine" },
    { slug: "student_law", label: "Law" },
    { slug: "student_design_arts", label: "Design & Arts" },
  ],
  /*
   * Deliberately empty, not missing.
   *
   * "Something else" exists because the taxonomy did not fit. Sub-dividing the
   * bucket for people the buckets failed would be inventing a structure they
   * already told us they are outside of. They get no tag row, which is the same
   * thing anybody who has not picked gets.
   */
  other: [],
}

const BY_SLUG = new Map<string, { expertise: Expertise; workField: string }>()
for (const [workField, list] of Object.entries(EXPERTISE_BY_FIELD)) {
  for (const expertise of list) BY_SLUG.set(expertise.slug, { expertise, workField })
}

/** What to offer somebody, given the field they picked. Never undefined. */
export function expertiseFor(workField: string | null | undefined): readonly Expertise[] {
  if (!workField) return []
  return EXPERTISE_BY_FIELD[workField] ?? []
}

/** Whether this slug exists at all, in any field. */
export function isExpertise(slug: unknown): slug is string {
  return typeof slug === "string" && BY_SLUG.has(slug)
}

/** The field that owns a slug, or null. */
export function workFieldOf(slug: string): string | null {
  return BY_SLUG.get(slug)?.workField ?? null
}

/** Labels for stored slugs, in the order given. A card never renders a slug. */
export function expertiseLabels(slugs: readonly string[] | null | undefined): string[] {
  if (!slugs) return []
  return slugs.map((s) => BY_SLUG.get(s)?.expertise.label).filter((l): l is string => !!l)
}

/**
 * The subset of `slugs` that is valid for `workField`, capped and deduplicated.
 *
 * **Called on every profile write, not only when expertise is being set.**
 * Changing your work field is the case this exists for: without it, somebody
 * who moves from Design to Finance keeps "UX Psychology" on their card forever
 * — a fossil of an attribute they have changed, sitting under a heading that
 * contradicts it.
 *
 * Silently drops rather than rejecting. A work-field change is a legitimate
 * edit, and refusing it with "your expertise is invalid" would make the user
 * clear a field they cannot see to change one they can.
 */
export function pruneExpertise(
  slugs: readonly string[] | null | undefined,
  workField: string | null | undefined
): string[] {
  if (!slugs || !workField) return []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const slug of slugs) {
    if (seen.has(slug)) continue
    if (workFieldOf(slug) !== workField) continue
    seen.add(slug)
    kept.push(slug)
    if (kept.length === MAX_EXPERTISE) break
  }
  return kept
}

/**
 * Every work field has a list, or is knowingly empty.
 *
 * Exported for the test rather than run at import: a field added to
 * `WORK_FIELDS` with no entry here would silently offer nobody anything, and
 * "the picker was empty" is the kind of bug that gets diagnosed as a network
 * failure.
 */
export function workFieldsMissingExpertise(): string[] {
  return WORK_FIELDS.map((f) => f.slug).filter((slug) => !(slug in EXPERTISE_BY_FIELD))
}
