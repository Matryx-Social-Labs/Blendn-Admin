"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { IconCheck } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { filePublicVenueClaim } from "@/lib/venue-claim-actions"

/**
 * The no-account claim, in two writes: the application, then the claim.
 *
 * `POST /api/onboarding/apply` stays the only writer of applications — it owns
 * the duplicate check, the tier, the email confirmation and the 3-per-hour
 * limit — so this posts to it as a venue owner, takes the `requestId` back,
 * and files the claim against it. The event claim form does the same.
 *
 * A venue owner is always a company (the apply route forces it), so the
 * company/individual choice on the event form is not asked here, and the
 * registered legal name always is.
 */
const schema = z.object({
  organisationName: z.string().trim().min(2, "What is the business called?").max(120),
  legalName: z.string().trim().min(2, "Give the registered legal name.").max(200),
  contactName: z.string().trim().min(2, "Who should we reply to?").max(120),
  contactEmail: z.string().trim().email("Give an email address we can reply to"),
  gstin: z.string().trim().max(20).optional(),
  website: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
})

type Values = z.infer<typeof schema>

/**
 * The venue-owner application, through the one route that writes them. Its
 * refusals are written for a person ("we already have an application from
 * this address"), so they are shown as-is.
 */
async function applyAsVenueOwner(values: Values): Promise<{ requestId: string } | { error: string }> {
  const res = await fetch("/api/onboarding/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requested_role: "venue_owner",
      kind: "company",
      display_name: values.organisationName,
      legal_name: values.legalName,
      gstin: values.gstin,
      website: values.website,
      contact_name: values.contactName,
      contact_email: values.contactEmail,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.requestId) {
    return { error: body?.error ?? "Could not start your application. Try again in a moment." }
  }
  return { requestId: body.requestId as string }
}

export function VenueClaimForm({ venueId, venueName }: { venueId: string; venueName: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [filed, setFiled] = useState(false)
  /*
   * The application this form already filed. A claim refused after the apply
   * succeeded (the limiter, the venue claimed meanwhile, a network blip) must
   * be retryable: applying again answers 409 "we already have an application
   * from this address", and the claimant would be stuck with an application
   * and no claim. So a retry files the claim against the one already made.
   */
  const [applied, setApplied] = useState<{ email: string; requestId: string } | null>(null)

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { organisationName: "", legalName: "", contactName: "", contactEmail: "", gstin: "", website: "", note: "" },
  })

  const submit = (values: Values) => {
    setError(null)
    startTransition(async () => {
      const email = values.contactEmail.trim().toLowerCase()
      let requestId = applied?.email === email ? applied.requestId : null
      if (!requestId) {
        const outcome = await applyAsVenueOwner(values)
        if ("error" in outcome) {
          setError(outcome.error)
          return
        }
        requestId = outcome.requestId
        setApplied({ email, requestId })
      }

      const result = await filePublicVenueClaim({
        venueId,
        contactEmail: values.contactEmail,
        onboardingId: requestId,
        gstin: values.gstin,
        note: values.note,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setFiled(true)
    })
  }

  if (filed) {
    return (
      <Card className="flex flex-col gap-2 rounded-xl p-5" role="status">
        <p className="inline-flex items-center gap-2 text-[0.875rem] font-medium">
          <IconCheck className="size-4" />
          Filed. We will read it.
        </p>
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          A person reads every claim. Nothing about {venueName} changes until they do. We will reply
          to the address you gave — confirm it first if we have sent you a link.
        </p>
      </Card>
    )
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <Card className="flex flex-col gap-4 rounded-xl p-5">
          <FormField
            control={form.control}
            name="organisationName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Business name</FormLabel>
                <FormControl>
                  <Input placeholder={venueName} {...field} />
                </FormControl>
                <FormDescription>This becomes your account on Blend&rsquo;n.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="legalName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Registered legal name</FormLabel>
                <FormControl>
                  <Input placeholder="Hospitality Pvt Ltd" {...field} />
                </FormControl>
                <FormDescription>
                  As on the registration. It is what a reviewer checks the claim against.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="contactName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your name</FormLabel>
                <FormControl>
                  <Input placeholder="Priya Nair" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="contactEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="manager@yourvenue.in" {...field} />
                </FormControl>
                <FormDescription>
                  An address at the venue&rsquo;s own domain is the strongest thing you can give us.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="gstin"
            render={({ field }) => (
              <FormItem>
                <FormLabel>GSTIN (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="29AABCU9603R1ZJ" autoCapitalize="characters" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="website"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Website (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="https://yourvenue.in" {...field} />
                </FormControl>
                <FormDescription>
                  From a personal address, give a GSTIN or a website. A venue address needs neither.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="note"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Anything that proves it (optional)</FormLabel>
                <FormControl>
                  <Textarea rows={3} placeholder="I manage the place. Our Instagram is…" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {error ? (
            <p role="alert" className="text-[0.8125rem] text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Filing…" : "This is my place"}
            </Button>
            <span className="text-[0.75rem] text-muted-foreground">
              A person reads it. Nothing changes until they do.
            </span>
          </div>
          <p className="text-[0.75rem] text-muted-foreground">
            Already have a venue account?{" "}
            <Link href={`/dashboard/venues/${venueId}/claim`} className="underline underline-offset-4 hover:text-foreground">
              Sign in and claim it from your dashboard
            </Link>
            .
          </p>
        </Card>
      </form>
    </Form>
  )
}
