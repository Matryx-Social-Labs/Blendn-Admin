"use client"

import { useState, useTransition } from "react"
import { IconCircleCheck, IconDeviceMobile, IconDeviceDesktop, IconLogout } from "@tabler/icons-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { passwordStrength, MIN_LENGTH } from "@/lib/password-strength"
import {
  changePassword,
  revokeMobileSessions,
  signOutEverywhereElse,
  updateProfile,
} from "@/lib/account-actions"

interface Account {
  name: string
  email: string
  image: string | null
  role: string
  hasPassword: boolean
  mobileSessions: number
}

/**
 * Two columns on desktop: what the section is on the left, the controls on the
 * right. Sections are independent — each saves on its own, so nothing is a
 * page-wide form with one Save button that makes you wonder what it touched.
 */
function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-6 border-b border-border py-6 @3xl/main:grid-cols-[minmax(180px,240px)_minmax(0,480px)]">
      <div className="flex flex-col gap-1">
        <h2 className="text-[0.9375rem] font-bold">{title}</h2>
        <p className="text-[0.78125rem] text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
    </section>
  )
}

export function SettingsForm({
  account,
  sessionCount,
}: {
  account: Account
  sessionCount: number
}) {
  return (
    <div className="flex max-w-4xl flex-col">
      <ProfileSection account={account} />
      {account.hasPassword ? (
        <PasswordSection email={account.email} name={account.name} />
      ) : (
        <Section
          title="Password"
          description="How you sign in."
        >
          <p className="text-sm leading-6 text-muted-foreground">
            This account signs in with Google, so there is no password to change. Manage it in
            your Google account.
          </p>
        </Section>
      )}
      <SessionsSection dashboardSessions={sessionCount} mobileSessions={account.mobileSessions} />
    </div>
  )
}

function ProfileSection({ account }: { account: Account }) {
  const [name, setName] = useState(account.name)
  const [pending, start] = useTransition()
  const dirty = name.trim() !== account.name.trim()
  const initials =
    account.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "B"

  return (
    <Section title="Profile" description="How colleagues in your organisation see you.">
      <div className="flex items-center gap-3.5">
        <Avatar className="size-13">
          <AvatarImage src={account.image ?? undefined} alt="" />
          <AvatarFallback className="bg-[image:var(--gradient-brand)] text-lg font-bold text-brand-ink">
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="text-[0.78125rem] text-muted-foreground">
          Your avatar comes from your Google account.
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={account.email} disabled />
        {/* Honest about the limitation rather than offering a "Change…" button
            that opens a flow which does not exist. */}
        <p className="text-[0.75rem] text-muted-foreground">
          Your email is your sign-in and cannot be changed here yet — contact support.
        </p>
      </div>

      <div>
        {/* Secondary: the password change below is the action this page
            exists for, and a screen gets one brand-orange button. */}
        <Button
          variant="secondary"
          disabled={!dirty || pending || name.trim().length < 2}
          onClick={() =>
            start(async () => {
              try {
                await updateProfile(name)
                toast.success("Profile updated")
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not save")
              }
            })
          }
        >
          Save
        </Button>
      </div>
    </Section>
  )
}

function PasswordSection({ email, name }: { email: string; name: string }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [done, setDone] = useState(false)
  const [pending, start] = useTransition()

  const strength = passwordStrength(next, { email, name })
  const mismatch = confirm.length > 0 && confirm !== next
  const canSubmit = current.length > 0 && strength.acceptable && confirm === next && !pending

  if (done) {
    return (
      <Section title="Password" description="Your sign-in credential.">
        <div className="flex items-center gap-2.5 rounded-lg border border-success px-3.5 py-3 text-sm">
          <IconCircleCheck className="size-5 shrink-0 text-success" />
          <span>
            Password changed. Your other sessions stay signed in — end them below if that
            wasn&apos;t you.
          </span>
        </div>
      </Section>
    )
  }

  return (
    <Section
      title="Password"
      description="Your first password was generated and emailed to you — set your own here."
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="current">Current password</Label>
        <Input
          id="current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="next">New password</Label>
        <Input
          id="next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        {/* The meter and the submit gate read the same function, so the bar
            cannot fill green on a password the form then refuses. */}
        <div className="flex gap-1" aria-hidden>
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={cn(
                "h-1 flex-1 rounded-sm transition-colors",
                strength.score >= i
                  ? strength.score >= 3
                    ? "bg-success"
                    : strength.score === 2
                      ? "bg-chart-2"
                      : "bg-destructive"
                  : "bg-surface-raised"
              )}
            />
          ))}
        </div>
        {next ? (
          <p
            className={cn(
              "text-[0.71875rem]",
              strength.acceptable ? "text-success" : "text-muted-foreground"
            )}
          >
            {strength.label}
            {strength.advice ? ` — ${strength.advice}` : ""}
          </p>
        ) : (
          <p className="text-[0.71875rem] text-muted-foreground">
            At least {MIN_LENGTH} characters. Length helps more than symbols do.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch ? (
          <p className="text-[0.71875rem] text-destructive">
            Doesn&apos;t match the new password yet.
          </p>
        ) : null}
      </div>

      <div>
        <Button
          disabled={!canSubmit}
          onClick={() =>
            start(async () => {
              const result = await changePassword(current, next)
              if (result.ok) {
                setDone(true)
                setCurrent("")
                setNext("")
                setConfirm("")
                toast.success("Password changed")
              } else {
                toast.error(result.error ?? "Could not change password")
              }
            })
          }
        >
          Change password
        </Button>
      </div>
    </Section>
  )
}

function SessionsSection({
  dashboardSessions,
  mobileSessions,
}: {
  dashboardSessions: number
  mobileSessions: number
}) {
  const [confirming, setConfirming] = useState<"dashboard" | "mobile" | null>(null)
  const [pending, start] = useTransition()

  return (
    <Section
      title="Sessions"
      description="Everywhere this account is signed in. Ending a session requires the password to sign back in."
    >
      {/*
        NextAuth records no device or location, so this shows counts rather than
        inventing a "Chrome · macOS · Bengaluru" line the database cannot
        support. Two separate systems, because they are two separate systems: a
        dashboard sign-out does not touch the mobile app's 30-day refresh
        tokens, and someone who has lost a phone needs exactly that.
      */}
      <div className="divide-y divide-border border-y border-border">
        <SessionRow
          icon={<IconDeviceDesktop className="size-[17px]" />}
          label="Dashboard"
          count={dashboardSessions}
          confirming={confirming === "dashboard"}
          pending={pending}
          onAsk={() => setConfirming("dashboard")}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            start(async () => {
              const n = await signOutEverywhereElse()
              toast.success(n === 0 ? "No other sessions to end" : `${n} session${n === 1 ? "" : "s"} ended`)
              setConfirming(null)
            })
          }
        />
        <SessionRow
          icon={<IconDeviceMobile className="size-[17px]" />}
          label="Mobile app"
          count={mobileSessions}
          confirming={confirming === "mobile"}
          pending={pending}
          onAsk={() => setConfirming("mobile")}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            start(async () => {
              const n = await revokeMobileSessions()
              toast.success(n === 0 ? "No mobile sessions to end" : `${n} mobile session${n === 1 ? "" : "s"} ended`)
              setConfirming(null)
            })
          }
        />
      </div>
    </Section>
  )
}

function SessionRow({
  icon,
  label,
  count,
  confirming,
  pending,
  onAsk,
  onCancel,
  onConfirm,
}: {
  icon: React.ReactNode
  label: string
  count: number
  confirming: boolean
  pending: boolean
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-3 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">
        {label}
        <span className="text-faint-foreground">
          {" "}
          · {count} active session{count === 1 ? "" : "s"}
        </span>
      </span>
      {confirming ? (
        <span className="flex items-center gap-2">
          <span className="text-[0.75rem] text-destructive">
            Ends {count} session{count === 1 ? "" : "s"} immediately.
          </span>
          <Button size="sm" variant="destructive" disabled={pending} onClick={onConfirm}>
            End
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="outline" disabled={count === 0 || pending} onClick={onAsk}>
          <IconLogout className="size-4" /> Sign out
        </Button>
      )}
    </div>
  )
}
