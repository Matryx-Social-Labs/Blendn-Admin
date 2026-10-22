import { redirect } from "next/navigation"
import { IconInbox } from "@tabler/icons-react"

import { Callout, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getOnboardingRequests } from "@/lib/onboarding-actions"
import { emailConfigured } from "@/lib/email"

import { OnboardingQueue } from "./queue"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/onboarding")

export const dynamic = "force-dynamic"

/**
 * Host applications awaiting review.
 *
 * Every application is reviewed by a person — the tier and the GSTIN checksum
 * decide what an applicant had to supply, never whether a human looks. This
 * screen exists to make that look cheap: everything the reviewer needs is on
 * the row, so approving is one read and one click.
 */
/**
 * Declined applications are history, not a queue, so only the recent ones are
 * drawn — but the screen says how many there are, because a list that stops at
 * twenty and looks complete is the same lie as an uncapped one that is not.
 */
const DECLINED_SHOWN = 20

export default async function OnboardingPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const [pending, decided] = await Promise.all([
    getOnboardingRequests("pending"),
    getOnboardingRequests("declined"),
  ])

  return (
    <div className="flex flex-col gap-5">
      {/*
        The paragraph explaining the submission rule is gone.

        It said a company address was accepted as-is and a personal one had to
        supply a GSTIN or a website — which is true, and is what the badges on
        every row already show. Explaining the gate above the queue is
        explaining the product inside the product to somebody who has read it a
        hundred times, and it pushed the first decision below the fold.

        What it was really carrying — "neither is proof" — now lives where it
        changes a decision: the domain badge is a credential, an aggregator
        domain is a warning, and the two are no longer the same colour.
      */}
      {!emailConfigured() ? (
        <Callout title="Email is not configured.">
          Applicants cannot confirm their address, and approving one will not send them their sign-in details — a
          one-time link is shown to you instead, to pass on yourself. Set{" "}
          <code className="rounded bg-muted px-1">RESEND_API_KEY</code> and{" "}
          <code className="rounded bg-muted px-1">EMAIL_FROM</code> to turn this on.
        </Callout>
      ) : null}

      {pending.rows.length === 0 ? (
        <EmptyState
          icon={<IconInbox />}
          title="Nothing to review"
          description="New host applications land here. Anyone can apply at /apply — no account is created until you approve one."
        />
      ) : (
        <>
          <OnboardingQueue rows={pending.rows} generatedAt={new Date().toISOString()} />
          {pending.total > pending.rows.length ? (
            /* A cap the screen does not mention is an admin who reads the page,
               believes it is the queue, and stops looking. */
            <p className="text-[0.8125rem] text-muted-foreground">
              Showing {pending.rows.length} of {pending.total}.
            </p>
          ) : null}
        </>
      )}

      {decided.rows.length > 0 ? (
        <Panel
          title="Declined"
          hint={
            decided.total > DECLINED_SHOWN
              ? `showing ${Math.min(DECLINED_SHOWN, decided.rows.length)} of ${decided.total}`
              : "most recent first"
          }
          bodyClassName="gap-0 px-0 pb-0 pt-3"
        >
          <ul>
            {decided.rows.slice(0, DECLINED_SHOWN).map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border px-5 py-3 text-[0.8125rem]"
              >
                <span className="font-medium">{r.display_name}</span>
                <span className="text-muted-foreground">{r.contact_email}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}
