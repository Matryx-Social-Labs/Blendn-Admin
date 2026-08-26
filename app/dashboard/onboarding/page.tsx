import { redirect } from "next/navigation"
import { IconInbox } from "@tabler/icons-react"

import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getOnboardingRequests } from "@/lib/onboarding-actions"
import { emailConfigured } from "@/lib/email"

import { OnboardingQueue } from "./queue"

export const dynamic = "force-dynamic"

/**
 * Host applications awaiting review.
 *
 * Every application is reviewed by a person — the tier and the GSTIN checksum
 * decide what an applicant had to supply, never whether a human looks. This
 * screen exists to make that look cheap: everything the reviewer needs is on
 * the row, so approving is one read and one click.
 */
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
      {/* The submission rule, which decides how much weight a row deserves and
          is invisible from the row itself. */}
      <p className="text-[0.8125rem] text-muted-foreground">
        A company email address was accepted as-is; a personal one had to supply a
        GSTIN or a website. Neither is proof — both are shown so you can weigh them.
      </p>

      {!emailConfigured() ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-[0.8125rem] leading-6">
          <strong className="font-semibold">Email is not configured.</strong> Applicants cannot
          confirm their address, and approving one will not send them their sign-in details — the
          password is shown to you once instead, to pass on yourself. Set{" "}
          <code className="rounded bg-muted px-1">RESEND_API_KEY</code> and{" "}
          <code className="rounded bg-muted px-1">EMAIL_FROM</code> to turn this on.
        </div>
      ) : null}

      {pending.length === 0 ? (
        <EmptyState
          icon={<IconInbox />}
          title="Nothing to review"
          description="New host applications land here. Anyone can apply at /apply — no account is created until you approve one."
        />
      ) : (
        <OnboardingQueue rows={pending} />
      )}

      {decided.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[length:var(--text-h2)] font-bold">Declined</h2>
          <div className="flex flex-col gap-2">
            {decided.slice(0, 20).map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 text-[0.8125rem]"
              >
                <span className="font-medium">{r.display_name}</span>
                <span className="text-muted-foreground">{r.contact_email}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
