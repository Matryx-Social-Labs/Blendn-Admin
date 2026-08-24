"use client"

import { useState, useTransition } from "react"
import { useForm, useWatch } from "react-hook-form"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { fileEventClaim } from "@/lib/event-claim-actions"

/**
 * Two paths, one screen.
 *
 * Somebody signed in with an organisation has already proved who they are to
 * the extent this step can; they need one button. Somebody with no account is
 * the common case — a curated event exists precisely because its organiser is
 * not on the platform — and they need to say who they are first.
 *
 * ## The no-account path goes through the existing apply endpoint
 *
 * `POST /api/onboarding/apply` stays the **only** writer of
 * `organiser_onboarding_requests`. It owns the duplicate check, the tier, the
 * email token and the verification mail, and reproducing any of that here
 * would be a second writer for one concept — the shape of half the findings in
 * this codebase's audit. So this posts to it, takes the `requestId` back, and
 * files the claim against it.
 *
 * That also explains why `fileEventClaim` accepts an `onboardingId` from the
 * browser but never an `orgId`: a pending application grants nothing, and an
 * organisation id names a real owner that already exists.
 */
const schema = z.object({
  contactEmail: z.string().trim().email("Give an email address we can reply to"),
  organisationName: z.string().trim().max(120).optional(),
  contactName: z.string().trim().max(120).optional(),
  /*
   * `kind`, `legalName` and `website` exist because `canSubmitApplication`
   * (`lib/org-invites.ts:200`) requires them, not because this form wanted
   * them.
   *
   * The first draft hardcoded `kind: "company"` and collected neither, and the
   * apply endpoint refused every submission with "A company must give its
   * registered legal name." `tsc` was clean, 1630 tests were green, and the
   * build compiled the route -- the funnel was simply broken end to end, and
   * only opening it in a browser said so. Same lesson as T79, one layer down:
   * a two-service handshake is not verified by either service compiling.
   */
  kind: z.enum(["individual", "company"]),
  legalName: z.string().trim().max(200).optional(),
  website: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
})

type Values = z.infer<typeof schema>

export function ClaimForm({ eventId, hasOrg }: { eventId: string; hasOrg: boolean }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [filed, setFiled] = useState(false)

  const form = useForm<Values>({
    resolver: zodResolver(
      hasOrg
        ? schema
        : schema.extend({
            organisationName: z.string().trim().min(2, "What is the organisation called?").max(120),
            contactName: z.string().trim().min(2, "Who should we reply to?").max(120),
          }).refine(
            (v) => v.kind !== "company" || (v.legalName ?? "").trim().length >= 2,
            { message: "A company has to give its registered legal name.", path: ["legalName"] }
          )
    ),
    defaultValues: {
      contactEmail: "",
      organisationName: "",
      contactName: "",
      kind: "company",
      legalName: "",
      website: "",
      note: "",
    },
  })

  /*
   * `useWatch`, not `form.watch`: the latter returns a fresh function each
   * render, so the React Compiler skips memoizing the whole component and says
   * so as a lint warning. Same subscription, memo-safe.
   */
  const kind = useWatch({ control: form.control, name: "kind" })

  const submit = (values: Values) => {
    setError(null)
    startTransition(async () => {
      let onboardingId: string | undefined

      if (!hasOrg) {
        const res = await fetch("/api/onboarding/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requested_role: "organizer",
            kind: values.kind,
            display_name: values.organisationName,
            legal_name: values.legalName,
            website: values.website,
            contact_name: values.contactName,
            contact_email: values.contactEmail,
          }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body?.requestId) {
          /*
           * The apply endpoint's 409s are the useful ones -- "we already have
           * an application from this address" -- and they are already written
           * for a human, so they are shown rather than replaced.
           */
          setError(body?.error ?? "Could not start your application. Try again in a moment.")
          return
        }
        onboardingId = body.requestId as string
      }

      const result = await fileEventClaim({
        eventId,
        contactEmail: values.contactEmail,
        note: values.note,
        onboardingId,
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
      <Card className="flex flex-col gap-2 rounded-xl p-5">
        <p className="inline-flex items-center gap-2 text-[0.875rem] font-medium">
          <IconCheck className="size-4" />
          Filed. We will read it.
        </p>
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          A person reads every claim — nothing about this is automatic, because approving hands over
          an attendee list and there is no undo. We will reply to the address you gave.
          {hasOrg ? null : " Confirm your email first if we have sent you a link."}
        </p>
      </Card>
    )
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <Card className="flex flex-col gap-4 rounded-xl p-5">
          {hasOrg ? null : (
            <>
              <FormField
                control={form.control}
                name="organisationName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Organisation</FormLabel>
                    <FormControl>
                      <Input placeholder="The Humming Tree" {...field} />
                    </FormControl>
                    <FormDescription>
                      Who runs the night. This becomes your account on the platform.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Is that a company?</FormLabel>
                    <FormControl>
                      <RadioGroup
                        value={field.value}
                        onValueChange={field.onChange}
                        className="flex gap-4 pt-1"
                      >
                        <label className="flex items-center gap-2 text-[0.8125rem]">
                          <RadioGroupItem value="company" /> A registered company
                        </label>
                        <label className="flex items-center gap-2 text-[0.8125rem]">
                          <RadioGroupItem value="individual" /> Just me
                        </label>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {kind === "company" ? (
                <FormField
                  control={form.control}
                  name="legalName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Registered legal name</FormLabel>
                      <FormControl>
                        <Input placeholder="Humming Tree Hospitality Pvt Ltd" {...field} />
                      </FormControl>
                      <FormDescription>
                        As it appears on the registration — it is what a reviewer checks the claim
                        against.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

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
                name="website"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Website (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="https://thehummingtree.com" {...field} />
                    </FormControl>
                    <FormDescription>
                      Only needed if you apply from a personal address — a company address needs
                      nothing else.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}

          <FormField
            control={form.control}
            name="contactEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="events@thehummingtree.com" {...field} />
                </FormControl>
                <FormDescription>
                  An address at the same domain as the listing is the strongest thing you can give
                  us — it is what a reviewer looks at first.
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
                  <Textarea
                    rows={3}
                    placeholder="We run this every Friday — here is our Instagram, and the ticket page is ours."
                    {...field}
                  />
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
              {pending ? "Filing…" : "This is my event"}
            </Button>
            <span className="text-[0.75rem] text-muted-foreground">
              A person reads it. Nothing is automatic.
            </span>
          </div>
        </Card>
      </form>
    </Form>
  )
}
