"use client"

import { useState, useTransition } from "react"
import {
  IconCircleCheck,
  IconClock,
  IconMail,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  claimDomain,
  decideJoinRequest,
  inviteMember,
  removeDomain,
  removeMember,
  revokeInvite,
  setMemberRole,
  sendDomainVerifyEmail,
  verifyDomain,
  type MyOrg,
  type OrgInviteRow,
  type OrgJoinRequestRow,
  type OrgMemberRow,
} from "@/lib/org-actions"
import type { OrgPermissions } from "@/lib/org-permissions"
import type { org_role } from "@prisma/client"

const ROLE_LABEL: Record<org_role, string> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
}

const ROLE_BLURB: Record<org_role, string> = {
  owner: "Everything, including domains and removing the organisation.",
  admin: "Members and events. Cannot verify domains.",
  staff: "Events and chat. Cannot change who is in the organisation.",
}

export function OrgPanel({
  org,
  members,
  invites,
  joinRequests,
  permissions,
}: {
  org: MyOrg
  members: OrgMemberRow[]
  invites: OrgInviteRow[]
  joinRequests: OrgJoinRequestRow[]
  permissions: OrgPermissions
}) {
  return (
    <section className="flex flex-col gap-5">
      {/* One title line. Status and your role are words beside the name, not
          chips — neither is an action, and the card around all of it is gone. */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-[length:var(--text-h2)] font-bold">{org.display_name}</h2>
        <span className="text-[0.8125rem] text-muted-foreground">
          {org.legal_name ? `${org.legal_name} · ` : ""}
          {org.status} · you are {org.myRole === "owner" ? "the owner" : ROLE_LABEL[org.myRole].toLowerCase()}
        </span>
      </div>

      <Members
        orgId={org.id}
        members={members}
        canManage={permissions.canManageMembers}
        myRole={org.myRole}
      />

      {permissions.canManageMembers ? (
        <>
          <JoinRequests orgId={org.id} requests={joinRequests} />
          <Invites orgId={org.id} invites={invites} verifiedDomains={org.domains.filter((d) => d.verified)} myRole={org.myRole} />
        </>
      ) : null}

      {permissions.canVerifyDomain ? <Domains orgId={org.id} domains={org.domains} /> : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

function Members({
  orgId,
  members,
  canManage,
  myRole,
}: {
  orgId: string
  members: OrgMemberRow[]
  canManage: boolean
  myRole: org_role
}) {
  const [pending, start] = useTransition()

  function change(memberId: string, role: org_role) {
    start(async () => {
      try {
        await setMemberRole(orgId, memberId, role)
        toast.success("Role updated")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update role")
      }
    })
  }

  function remove(memberId: string, name: string) {
    start(async () => {
      try {
        await removeMember(orgId, memberId)
        toast.success(`${name} removed`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not remove")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-[0.9375rem] font-bold">Members</h3>
      <div className="flex flex-col divide-y divide-border">
        {members.map((m) => (
          <div
            key={m.id}
            className="flex flex-wrap items-center justify-between gap-3 py-2.5"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {m.name ?? m.email}
                {m.isPrimary ? (
                  <span className="ml-2 text-[0.75rem] font-normal text-faint-foreground">
                    primary contact
                  </span>
                ) : null}
              </span>
              <span className="text-[0.8125rem] text-muted-foreground">{m.email}</span>
            </div>

            {canManage ? (
              <div className="flex items-center gap-2">
                <Select
                  value={m.role}
                  onValueChange={(v) => change(m.id, v as org_role)}
                  disabled={pending || (m.role === "owner" && myRole !== "owner")}
                >
                  <SelectTrigger className="w-32" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["owner", "admin", "staff"] as org_role[]).map((r) => (
                      <SelectItem key={r} value={r} disabled={r === "owner" && myRole !== "owner"}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => remove(m.id, m.name ?? m.email)}
                  aria-label={`Remove ${m.name ?? m.email}`}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            ) : (
              <span className="text-[0.8125rem] text-muted-foreground">{ROLE_LABEL[m.role]}</span>
            )}
          </div>
        ))}
      </div>
      {canManage ? (
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          Admin: {ROLE_BLURB.admin} Staff: {ROLE_BLURB.staff}
        </p>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Invites({
  orgId,
  invites,
  verifiedDomains,
  myRole,
}: {
  orgId: string
  invites: OrgInviteRow[]
  verifiedDomains: MyOrg["domains"]
  myRole: org_role
}) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<org_role>("staff")
  const [reason, setReason] = useState("")
  const [needsReason, setNeedsReason] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function send() {
    start(async () => {
      try {
        const result = await inviteMember(orgId, email, role, reason || undefined)
        if (!result.ok) {
          setNeedsReason(!!result.needsReason)
          toast.error(result.message)
          return
        }
        toast.success(result.message)
        setEmail("")
        setReason("")
        setNeedsReason(false)
        setLink(result.link ?? null)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not invite")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-[0.9375rem] font-bold">Invite someone</h3>
      <p className="text-[0.8125rem] leading-6 text-muted-foreground">
        {verifiedDomains.length > 0
          ? `Invites go to ${verifiedDomains.map((d) => d.domain).join(", ")} without ceremony. Anyone else needs a reason, which is recorded.`
          : "Verify a domain below to restrict invites to it. Until then any address can be invited."}
      </p>

      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setNeedsReason(false)
          }}
          placeholder="colleague@yourcompany.com"
          className="h-9 min-w-56 flex-1 rounded-lg"
        />
        <Select value={role} onValueChange={(v) => setRole(v as org_role)}>
          <SelectTrigger className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["admin", "staff"] as org_role[]).map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABEL[r]}
              </SelectItem>
            ))}
            {myRole === "owner" ? <SelectItem value="owner">Owner</SelectItem> : null}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={send} disabled={pending || !email.trim()}>
          <IconMail className="size-4" /> Invite
        </Button>
      </div>

      {needsReason ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="text-[0.8125rem] leading-6">
            That address is outside your verified domain. Say why — it goes in the audit log.
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Freelance photographer for the Nov 12 event"
            className="rounded-lg"
          />
          <Button size="sm" onClick={send} disabled={pending || reason.trim().length < 8} className="self-start">
            Invite anyway
          </Button>
        </div>
      ) : null}

      {link ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-[0.8125rem] text-muted-foreground">
            Email isn&apos;t configured, so send them this link yourself:
          </p>
          <code className="select-all break-all text-[0.8125rem]">{link}</code>
        </div>
      ) : null}

      {invites.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Outstanding
          </p>
          {invites.map((i) => (
            <InviteRow key={i.id} orgId={orgId} invite={i} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function InviteRow({ orgId, invite }: { orgId: string; invite: OrgInviteRow }) {
  const [pending, start] = useTransition()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">{invite.email}</span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {ROLE_LABEL[invite.role]} · expires {invite.expiresAt.toLocaleDateString("en-GB", { timeZone: "UTC" })}
          {invite.overrideReason ? ` · outside domain: ${invite.overrideReason}` : ""}
        </span>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              await revokeInvite(orgId, invite.id)
              toast.success("Invite revoked")
            } catch {
              toast.error("Could not revoke")
            }
          })
        }
      >
        Revoke
      </Button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function JoinRequests({ orgId, requests }: { orgId: string; requests: OrgJoinRequestRow[] }) {
  const [pending, start] = useTransition()
  if (requests.length === 0) return null

  function decide(id: string, approve: boolean) {
    start(async () => {
      try {
        await decideJoinRequest(orgId, id, approve)
        toast.success(approve ? "Added as staff" : "Declined")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not decide")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-[0.9375rem] font-bold">Requests to join</h3>
      <p className="text-[0.8125rem] leading-6 text-muted-foreground">
        People with an address on your verified domain. Approving adds them as staff — promote them
        afterwards if they need more.
      </p>
      {requests.map((r) => (
        <div
          key={r.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2.5"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{r.name ?? r.email}</span>
            <span className="text-[0.8125rem] text-muted-foreground">{r.email}</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => decide(r.id, true)}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(r.id, false)}>
              Decline
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Domains({ orgId, domains }: { orgId: string; domains: MyOrg["domains"] }) {
  const [raw, setRaw] = useState("")
  const [instructions, setInstructions] = useState<{ host: string; value: string } | null>(null)
  const [pending, start] = useTransition()

  function claim() {
    start(async () => {
      try {
        const result = await claimDomain(orgId, raw)
        if (!result.ok) {
          toast.error(result.message)
          return
        }
        toast.success(result.message)
        setInstructions(result.instructions ? { host: result.instructions.host, value: result.instructions.value } : null)
        setRaw("")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not claim domain")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-[0.9375rem] font-bold">Domain</h3>
      <p className="text-[0.8125rem] leading-6 text-muted-foreground">
        Verifying a domain proves you control it, which is what lets invites be restricted to it.
        Add the TXT record at your DNS provider, then check.
      </p>

      {domains.map((d) => (
        <DomainRow key={d.id} orgId={orgId} domain={d} />
      ))}

      <div className="flex flex-wrap gap-2">
        <Input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="yourcompany.com"
          className="h-9 min-w-56 flex-1 rounded-lg"
        />
        <Button size="sm" variant="outline" onClick={claim} disabled={pending || !raw.trim()}>
          <IconWorld className="size-4" /> Add domain
        </Button>
      </div>

      {instructions ? (
        <dl className="grid gap-1 rounded-lg border border-border bg-muted/40 p-4 font-mono text-[0.8125rem]">
          <div className="flex gap-3">
            <dt className="w-16 text-muted-foreground">Type</dt>
            <dd>TXT</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 text-muted-foreground">Host</dt>
            <dd>{instructions.host}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted-foreground">Value</dt>
            <dd className="select-all break-all">{instructions.value}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  )
}

function DomainRow({ orgId, domain }: { orgId: string; domain: MyOrg["domains"][number] }) {
  const [pending, start] = useTransition()
  const [byEmail, setByEmail] = useState(false)
  const [address, setAddress] = useState("")

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2.5">
      <div className="flex items-center gap-2">
        {domain.verified ? (
          <IconCircleCheck className="size-4 text-success" />
        ) : (
          <IconClock className="size-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">{domain.domain}</span>
        {!domain.verified ? (
          <code className="select-all break-all text-[0.75rem] text-muted-foreground">
            blendn-verify={domain.token}
          </code>
        ) : null}
      </div>
      <div className="flex gap-2">
        {!domain.verified ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await verifyDomain(orgId, domain.id)
                if (result.ok) toast.success(result.message)
                else toast.error(result.message)
              })
            }
          >
            Check now
          </Button>
        ) : null}
        {/*
          The other half of the proof, which did not exist.
          *
          * Only the DNS TXT path was ever wired, and the person setting up the
          * account is rarely the person with access to the zone file — so an
          * organisation whose claimant is not the DNS administrator had no
          * route to a verified domain at all. A verified domain is what gates
          * auto-approval on event claims.
        */}
        {!domain.verified ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setByEmail((v) => !v)}>
            Email instead
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          disabled={pending}
          aria-label={`Remove ${domain.domain}`}
          onClick={() =>
            start(async () => {
              await removeDomain(orgId, domain.id)
              toast.success("Domain removed")
            })
          }
        >
          <IconTrash className="size-4" />
        </Button>
      </div>

      {byEmail && !domain.verified ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          {/*
            Role addresses only, and offered as a list rather than a free field.
            A personal address would prove that one employee works there, which
            is a different claim — and the one an attacker with any mailbox at a
            large company would like to make.
          */}
          <select
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label={`Role address at ${domain.domain}`}
            className="h-9 min-w-56 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Choose an address…</option>
            {domain.roleAddresses.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !address}
            onClick={() =>
              start(async () => {
                const result = await sendDomainVerifyEmail(orgId, domain.id, address)
                if (result.ok) {
                  toast.success(result.message)
                  setByEmail(false)
                } else {
                  toast.error(result.message)
                }
              })
            }
          >
            Send link
          </Button>
        </div>
      ) : null}
    </div>
  )
}
