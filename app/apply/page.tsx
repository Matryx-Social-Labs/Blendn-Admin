"use client"

import Image from "next/image"
import Link from "next/link"
import { useMemo, useState } from "react"
import { IconArrowRight, IconBuildingStore, IconCalendarEvent, IconCircleCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { onboardingTier } from "@/lib/org-invites"

/**
 * The public host application.
 *
 * One form rather than a wizard. The plan called for stages, but the only thing
 * a stage would gate is the extra proof required of a personal email address —
 * and that is better shown as a live hint the moment the address is typed than
 * as a step someone reaches and is refused at.
 *
 * `lib/org-invites` is imported directly: it is pure, has no database import,
 * and reusing it here is what keeps the hint the client shows and the rule the
 * server enforces from drifting apart.
 */

type Role = "organizer" | "venue_owner"

/**
 * The three objections someone actually has with the form in front of them.
 *
 * All three are true today and all three are checked elsewhere: pricing is
 * undecided and everything is free (`docs/ROADMAP.md`), nothing in this flow
 * touches payment, and `/dashboard/onboarding` is a queue a human reads.
 */
const REASSURANCES = [
  "Free while we're in development — pricing isn't decided yet.",
  "No card. There's nothing to enter and no trial to expire.",
  "Read by a person, not a filter. Usually within two working days.",
] as const

const ROLES: { value: Role; title: string; blurb: string; icon: typeof IconCalendarEvent }[] = [
  {
    value: "organizer",
    title: "I run events",
    blurb: "You host meetups, parties, screenings or club nights — at your own space or someone else's.",
    icon: IconCalendarEvent,
  },
  {
    value: "venue_owner",
    title: "I own a venue",
    blurb: "You run a bar, café, club or hall and want events hosted there listed on Blend'n.",
    icon: IconBuildingStore,
  },
]

export default function ApplyPage() {
  const [role, setRole] = useState<Role>("organizer")
  const [form, setForm] = useState({
    display_name: "",
    legal_name: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    gstin: "",
    website: "",
    city: "",
    address: "",
  })
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState<{ emailSent: boolean; message: string } | null>(null)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  // A venue owner is always a company; an individual organiser may be a sole
  // trader. Mirrors the same rule on the server.
  const isCompany = role === "venue_owner" || !!form.legal_name.trim()

  const needsProof = useMemo(
    () => form.contact_email.includes("@") && onboardingTier(form.contact_email) === "needs_proof",
    [form.contact_email]
  )
  const proofGiven = !!form.gstin.trim() || !!form.website.trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch("/api/onboarding/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          requested_role: role,
          kind: role === "venue_owner" ? "company" : isCompany ? "company" : "individual",
        }),
      })
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body.error ?? "Could not submit")
      setDone({ emailSent: body.emailSent, message: body.message })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit")
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <main className="apply-light apply-gradient flex min-h-screen items-center justify-center px-6 py-10">
        <Card className="apply-card w-full max-w-lg rounded-3xl">
          <CardContent className="space-y-5 px-8 py-10 text-center">
            <Image
              src="/brand/lockup-dark.webp"
              alt="Blend'n"
              width={852}
              height={240}
              className="mx-auto h-9 w-auto"
            />
            <IconCircleCheck className="mx-auto size-12 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">
              {done.emailSent ? "Check your email" : "Application received"}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">{done.message}</p>
            <p className="text-sm leading-6 text-muted-foreground">
              Applications are reviewed by a person, usually within two working days. No account has
              been created yet.
            </p>
            <Button asChild variant="outline" className="rounded-2xl">
              <Link href="/">Back to Blend&apos;n</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="apply-light apply-gradient relative min-h-screen px-6 py-10 md:px-10">
      <div className="apply-card apply-shell mx-auto grid overflow-hidden rounded-3xl border border-border bg-card lg:grid-cols-[0.9fr_1.1fr]">
        <section className="flex flex-col gap-8 border-b border-border px-6 py-10 lg:border-b-0 lg:border-r lg:px-10 lg:py-12">
          {/* The landing page's own lockup, not the monogram-plus-wordmark used
              in dashboard chrome — that pairing appears nowhere on the marketing
              site and would read as a third brand at the moment someone is
              deciding whether to trust us. */}
          <Image
            src="/brand/lockup-dark.webp"
            alt="Blend'n"
            width={852}
            height={240}
            priority
            className="h-9 w-auto self-start"
          />

          <div className="space-y-4">
            <span className="apply-chip">Become a host</span>
            <h1 className="max-w-xl text-4xl font-bold leading-tight tracking-tight text-foreground">
              List your events where people are looking for them.
            </h1>
            <p className="max-w-xl text-base leading-7 text-muted-foreground">
              Tell us about your organisation. We review every application by hand — it keeps the
              listings worth browsing.
            </p>
          </div>

          {/* Directly under the intro, not pinned to the bottom. `justify-between`
              left roughly 600px of dead space at desktop width, which reads as a
              rendering fault rather than as breathing room. */}
          <div className="space-y-3 rounded-2xl border border-border bg-muted/40 p-5">
            <h2 className="text-sm font-bold text-foreground">What happens next</h2>
            <ol className="space-y-2 text-sm leading-6 text-muted-foreground">
              <li>1. Confirm your email address.</li>
              <li>2. We review your application, usually within two working days.</li>
              <li>3. You get sign-in details and can invite your colleagues.</li>
            </ol>
          </div>

          {/* What actually goes through someone's head on this page. Not a
              testimonial — the landing page deleted two invented ones and this
              page must not restart the habit. */}
          <ul className="space-y-3.5">
            {REASSURANCES.map((r) => (
              <li key={r} className="flex items-start gap-2.5 text-sm leading-6 text-muted-foreground">
                <IconCircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                {r}
              </li>
            ))}
          </ul>
        </section>

        <section className="px-6 py-10 lg:px-10 lg:py-12">
          <form onSubmit={submit} className="mx-auto max-w-xl space-y-7">
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-foreground">Which are you?</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {ROLES.map((r) => (
                  <button
                    type="button"
                    key={r.value}
                    onClick={() => setRole(r.value)}
                    aria-pressed={role === r.value}
                    className={`rounded-2xl border p-4 text-left transition ${
                      role === r.value
                        ? "border-primary bg-primary/5"
                        : "border-border bg-muted/30 hover:border-muted-foreground/40"
                    }`}
                  >
                    <r.icon className="mb-2 size-5 text-primary" />
                    <div className="text-sm font-semibold text-foreground">{r.title}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{r.blurb}</p>
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-foreground">Your organisation</h2>
              <Field label="Name people will see" required>
                <Input
                  value={form.display_name}
                  onChange={set("display_name")}
                  placeholder="Byg Brewski Brewing Company"
                  className="h-11 rounded-xl"
                  required
                  minLength={2}
                />
              </Field>
              <Field
                label="Registered legal name"
                required={role === "venue_owner"}
                hint={
                  role === "venue_owner"
                    ? "As registered. Venue owners must apply as a company."
                    : "Leave blank if you operate as an individual."
                }
              >
                <Input
                  value={form.legal_name}
                  onChange={set("legal_name")}
                  placeholder="Byg Brewski Brewing Co. Pvt Ltd"
                  className="h-11 rounded-xl"
                  required={role === "venue_owner"}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="City">
                  <Input value={form.city} onChange={set("city")} placeholder="Bangalore" className="h-11 rounded-xl" />
                </Field>
                <Field label="Website">
                  <Input
                    value={form.website}
                    onChange={set("website")}
                    placeholder="bygbrewski.com"
                    className="h-11 rounded-xl"
                  />
                </Field>
              </div>
              <Field label="Address">
                <Textarea value={form.address} onChange={set("address")} rows={2} className="rounded-2xl" />
              </Field>
              <Field label="GSTIN" hint="15 characters. Checked for format only — we don't share it.">
                <Input
                  value={form.gstin}
                  onChange={set("gstin")}
                  placeholder="29AABCU9603R1ZJ"
                  className="h-11 rounded-xl font-mono uppercase"
                  maxLength={15}
                />
              </Field>
            </div>

            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-foreground">Person responsible</h2>
              <p className="-mt-2 text-xs leading-5 text-muted-foreground">
                Every organisation has one named person accountable for it. You can add colleagues
                once you&apos;re approved.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full name" required>
                  <Input
                    value={form.contact_name}
                    onChange={set("contact_name")}
                    className="h-11 rounded-xl"
                    required
                    minLength={2}
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    value={form.contact_phone}
                    onChange={set("contact_phone")}
                    placeholder="+91"
                    className="h-11 rounded-xl"
                  />
                </Field>
              </div>
              <Field
                label="Work email"
                required
                hint="We send the confirmation link here. A company address is fastest to approve."
              >
                <Input
                  type="email"
                  value={form.contact_email}
                  onChange={set("contact_email")}
                  placeholder="you@yourcompany.com"
                  className="h-11 rounded-xl"
                  required
                />
              </Field>

              {needsProof ? (
                <div
                  className={`rounded-2xl border p-4 text-sm leading-6 ${
                    proofGiven
                      ? "border-border bg-muted/40 text-muted-foreground"
                      : "border-amber-500/40 bg-amber-500/5 text-foreground"
                  }`}
                >
                  {proofGiven
                    ? "Thanks — that's enough to submit from a personal address."
                    : "That's a personal email address. Add a GSTIN or your website above and you can submit — a company address needs neither."}
                </div>
              ) : null}
            </div>

            <Button
              type="submit"
              disabled={loading || (needsProof && !proofGiven)}
              className="h-12 w-full rounded-2xl"
            >
              {loading ? "Submitting..." : "Submit application"}
              {!loading ? <IconArrowRight className="size-4" /> : null}
            </Button>

            <p className="text-sm text-muted-foreground">
              Already a host?{" "}
              <Link href="/login" className="text-foreground underline underline-offset-4">
                Sign in
              </Link>
            </p>
          </form>
        </section>
      </div>
    </main>
  )
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-foreground">
        {label}
        {required ? <span className="text-muted-foreground"> *</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
