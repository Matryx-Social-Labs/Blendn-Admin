"use client"

import { useCallback, useEffect, useState } from "react"
import { refusalText } from "@/lib/refusal"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CreativeMedia } from "@/components/creative-media"
import { PollComposer } from "@/components/poll-composer"
import { SPONSORED_MESSAGE_INTERVALS } from "@/lib/validations/event"
import { getEventSponsors, type EventSponsorRow } from "@/lib/sponsor-actions"
import {
  IconClock,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface SponsoredMessage {
  id: string
  content: string
  interval_minutes: number
  is_active: boolean
  last_sent_at: string | null
  created_at: string
  sponsor_id: string | null
  media_url: string | null
  moderation_status: "pending" | "approved" | "rejected"
  /** Why the scheduler gave up. Null while it is running or has never run. */
  deactivated_reason: string | null
  next_send_at: string | null
}

interface Announcement {
  id: string
  content: string
  created_at: string
  sender: { name: string | null; email: string }
}

// ── Quick templates ───────────────────────────────────────────────────────────

const QUICK_TEMPLATES: { label: string; text: string }[] = [
  { label: "Bar closing", text: "Bar closing in 30 minutes — grab your last orders!" },
  { label: "Parking", text: "Car owners, please check the parking area for any blocking vehicles." },
  { label: "Starting in 10", text: "Stage performance starting in 10 minutes — don't miss it!" },
  { label: "Restrooms", text: "Restrooms are located near the main entrance." },
  { label: "Lost & found", text: "Lost & found is at the help desk near gate 1." },
  { label: "Wrapping up", text: "Event wrapping up in 15 minutes. Thank you for joining us!" },
]


// ── Sponsored Messages Panel ──────────────────────────────────────────────────

function SponsoredMessagesPanel({ eventId }: { eventId: string }) {
  const [messages, setMessages] = useState<SponsoredMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)

  // New / edit form state
  const [formContent, setFormContent] = useState("")
  const [formInterval, setFormInterval] = useState(String(SPONSORED_MESSAGE_INTERVALS[0]))
  const [formSponsor, setFormSponsor] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  /*
   * The brands that may carry a campaign here. Approved placements only: an
   * invited sponsor has not accepted yet, and a cancelled one is how an
   * organiser stops sends.
   */
  const [sponsors, setSponsors] = useState<EventSponsorRow[]>([])
  useEffect(() => {
    getEventSponsors(eventId)
      .then((rows) => setSponsors(rows.filter((r) => r.status === "approved")))
      .catch(() => setSponsors([]))
  }, [eventId])

  /*
   * Whether the last load failed, as distinct from there being nothing to show.
   *
   * Without it a 403 or a 500 rendered as "No sponsored messages yet. Add one
   * to get started." — a failure explained as an absence, and an invitation to
   * create a duplicate of something the caller simply could not read.
   */
  const [failed, setFailed] = useState(false)

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/sponsored-messages`)
      if (!res.ok) {
        setFailed(true)
        return
      }
      setFailed(false)
      setMessages(await res.json())
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { void fetchMessages() }, [fetchMessages])

  const openAdd = () => {
    setEditingId(null)
    setFormContent("")
    setFormInterval(String(SPONSORED_MESSAGE_INTERVALS[0]))
    setFormSponsor(sponsors.length === 1 ? sponsors[0].sponsorId : "")
    setShowForm(true)
  }

  const openEdit = (msg: SponsoredMessage) => {
    setEditingId(msg.id)
    setFormContent(msg.content)
    setFormInterval(String(msg.interval_minutes))
    // Not editable: repointing a campaign would re-attribute sends already
    // recorded under it, so the API omits the field entirely.
    setFormSponsor(msg.sponsor_id ?? "")
    setShowForm(true)
  }

  const cancelForm = () => {
    setShowForm(false)
    setEditingId(null)
    setFormContent("")
  }

  const save = async () => {
    if (!formContent.trim()) return toast.error("Message content is required")
    if (!editingId && !formSponsor) return toast.error("Pick the brand this is for")
    try {
      setSaving(true)
      const url = editingId
        ? `/api/events/${eventId}/sponsored-messages/${editingId}`
        : `/api/events/${eventId}/sponsored-messages`
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: formContent,
          interval_minutes: Number(formInterval),
          ...(editingId ? {} : { sponsor_id: formSponsor }),
        }),
      })
      if (!res.ok) throw new Error(await refusalText(res, "That did not go through"))
      toast.success(
        editingId
          ? "Edited — it goes back for review before it can run again"
          : "Created. It runs once the copy has been reviewed."
      )
      cancelForm()
      await fetchMessages()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Failed to save message")
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (msg: SponsoredMessage) => {
    try {
      const res = await fetch(`/api/events/${eventId}/sponsored-messages/${msg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !msg.is_active }),
      })
      /*
       * The refusal, verbatim. `canActivate` returns seven distinct sentences —
       * no brand, placement not approved, no chatroom, in review, not approved —
       * and every one of them was previously flattened to "Failed to update",
       * which names none of the seven fixes.
       */
      if (!res.ok) throw new Error(await refusalText(res, "That did not go through"))
      // Re-read rather than assuming the flip landed: the server may have
      // written other fields with it.
      await fetchMessages()
      toast.success(msg.is_active ? "Stopped" : "Started sending")
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Failed to update")
    }
  }

  const remove = async (id: string) => {
    if (!confirm("Delete this sponsored message?")) return
    try {
      const res = await fetch(`/api/events/${eventId}/sponsored-messages/${id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      setMessages((prev) => prev.filter((m) => m.id !== id))
      toast.success("Deleted")
    } catch {
      toast.error("Failed to delete")
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[0.9375rem] font-bold">Sponsored messages</h3>
          <p className="mt-0.5 text-[0.75rem] text-faint-foreground">
            Sent to the room on a schedule, under the brand&apos;s name.
          </p>
        </div>
        {!showForm && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <IconPlus className="size-4 mr-1" />
            Add
          </Button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <p className="text-sm font-medium">{editingId ? "Edit message" : "New sponsored message"}</p>
          <Textarea
            placeholder="Your sponsored message…"
            rows={3}
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
          />
          {editingId ? null : (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Brand</p>
              {sponsors.length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  No approved sponsor on this event yet. A sponsored message is a
                  claim that somebody paid, so it needs a brand behind it — add
                  one above first.
                </p>
              ) : (
                <Select value={formSponsor} onValueChange={setFormSponsor}>
                  <SelectTrigger>
                    <SelectValue placeholder="Which brand is this for?" />
                  </SelectTrigger>
                  <SelectContent>
                    {sponsors.map((s) => (
                      <SelectItem key={s.sponsorId} value={s.sponsorId}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1">Send every</p>
              {/* One list, shared with the validator. The dropdown used to offer
                  10 and 15 minutes under a 20-minute room-wide gap that silently
                  overruled both. */}
              <Select value={formInterval} onValueChange={setFormInterval}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPONSORED_MESSAGE_INTERVALS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {minutes} minutes
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-5">
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelForm} aria-label="Cancel">
                <IconX className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : failed ? (
        <p className="text-sm text-muted-foreground">
          Those messages did not load. Nothing was changed — try again.
        </p>
      ) : messages.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-6 text-center text-sm text-muted-foreground">
          No sponsored messages yet. Add one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className="rounded-lg border bg-background p-3 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm leading-snug">{msg.content}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <Badge variant="outline" className="text-xs gap-1">
                    <IconClock className="size-3" />
                    Every {msg.interval_minutes} min
                  </Badge>
                  <Badge
                    variant={
                      msg.moderation_status === "approved"
                        ? "outline"
                        : msg.moderation_status === "rejected"
                          ? "destructive"
                          : "secondary"
                    }
                    className="text-xs"
                  >
                    {msg.moderation_status === "approved"
                      ? "Reviewed"
                      : msg.moderation_status === "rejected"
                        ? "Not approved"
                        : "In review"}
                  </Badge>
                  {msg.last_sent_at && (
                    <span className="text-xs text-muted-foreground">
                      Last sent {new Date(msg.last_sent_at).toLocaleTimeString()}
                    </span>
                  )}
                  {/*
                    Why it stopped, if it did. The scheduler switches a campaign
                    off for five different reasons — archived room, no creative,
                    repeated failures — and without this the organiser sees a
                    switch that turned itself off overnight and no explanation.
                  */}
                  {!msg.is_active && msg.deactivated_reason && (
                    <span className="text-xs text-destructive">{msg.deactivated_reason}</span>
                  )}
                </div>
                {/*
                  Attached to a SAVED campaign, never to the new-campaign form:
                  a grant is validated against a campaign id, which does not
                  exist until the campaign does.
                */}
                <div className="mt-2">
                  <CreativeMedia
                    eventId={eventId}
                    campaignId={msg.id}
                    currentUrl={msg.media_url}
                    onAttached={fetchMessages}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Switch
                  checked={msg.is_active}
                  onCheckedChange={() => toggleActive(msg)}
                  title={msg.is_active ? "Stop" : "Start"}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Edit message"
                  onClick={() => openEdit(msg)}
                >
                  <IconPencil className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  aria-label="Delete message"
                  onClick={() => remove(msg.id)}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type MessagingTab = "announcements" | "polls" | "sponsored"

// ── Announcements Panel ───────────────────────────────────────────────────────

function AnnouncementsPanel({ eventId }: { eventId: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  // Same distinction as the sponsored list above: a failed read is not an
  // empty one, and "No announcements sent yet" is a claim about the event.
  const [announcementsFailed, setAnnouncementsFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [content, setContent] = useState("")
  const [sending, setSending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [audience, setAudience] = useState({ members: 0, reachable: 0 })

  const fetchAnnouncements = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/announcements`)
      if (!res.ok) setAnnouncementsFailed(true)
      if (res.ok) {
        setAnnouncementsFailed(false)
        const body = await res.json()
        setAnnouncements(body.announcements ?? [])
        setAudience(body.audience ?? { members: 0, reachable: 0 })
      }
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { void fetchAnnouncements() }, [fetchAnnouncements])

  const send = async () => {
    if (!content.trim()) return toast.error("Please enter a message")
    try {
      setSending(true)
      const res = await fetch(`/api/events/${eventId}/announcements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error(await refusalText(res, "Failed to send announcement"))
      const created: Announcement = await res.json()
      setAnnouncements((prev) => [created, ...prev])
      setContent("")
      setConfirming(false)
      toast.success(
        audience.reachable > 0
          ? `Sent to the chatroom · ${audience.reachable} phone${audience.reachable === 1 ? "" : "s"} notified`
          : "Announcement sent to chatroom"
      )
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send announcement")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[0.9375rem] font-bold">Say something to the room</h3>
          {audience.members > 0 ? (
            <span className="text-[0.75rem] text-faint-foreground">
              {audience.members} member{audience.members === 1 ? "" : "s"} · {audience.reachable} phone
              {audience.reachable === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <Textarea
          placeholder="Type an announcement…"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        {/* Six one-tap openers. Short labels so they sit on one line; the
            full sentence lands in the box where it can be edited. */}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_TEMPLATES.map((t) => (
            <Button
              key={t.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (content.trim() && !window.confirm("Replace what you have typed?")) return
                setContent(t.text)
              }}
              className="h-7 rounded-full px-2.5 text-[0.75rem] font-normal text-muted-foreground"
            >
              {t.label}
            </Button>
          ))}
        </div>
        {/*
          The blast radius, before the send rather than after it.
          An announcement pushes a notification to every attendee's phone — the
          most powerful and most abusable thing a host can do — and this was a
          textarea with one button and no indication of how many people that
          was. The confirm names the number, and the number is distinct people
          who will actually get a notification, not chatroom members.
        */}
        {confirming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
            <p className="text-[0.8125rem] leading-6">
              This posts to the chatroom for{" "}
              <b className="font-semibold">{audience.members} member{audience.members === 1 ? "" : "s"}</b>
              {audience.reachable > 0 ? (
                <>
                  {" "}and pushes a notification to{" "}
                  <b className="font-semibold">
                    {audience.reachable} phone{audience.reachable === 1 ? "" : "s"}
                  </b>
                </>
              ) : (
                " · nobody has notifications enabled, so it appears in the chatroom only"
              )}
              . It cannot be unsent.
            </p>
            <div className="flex gap-2">
              <Button onClick={send} disabled={sending} size="sm">
                {sending ? "Sending…" : "Send now"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={sending}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={sending || !content.trim()}>
            {audience.reachable > 0
              ? `Send to ${audience.reachable} phone${audience.reachable === 1 ? "" : "s"}`
              : "Send to the room"}
          </Button>
        )}
        <p className="text-[0.75rem] text-faint-foreground">
          3 a minute. Attendees see the host, never your name.
        </p>
      </div>

      {/* History */}
      <div className="border-t border-border pt-4">
        <p className="mb-2 text-[0.9375rem] font-bold">Sent</p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : announcementsFailed ? (
          <p className="text-sm text-muted-foreground">
            Those announcements did not load. Nothing was sent — try again.
          </p>
        ) : announcements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No announcements sent yet.</p>
        ) : (
          <div className="space-y-2">
            {announcements.map((a) => (
              <div key={a.id} className="border-t border-border py-2 first:border-t-0">
                <p className="text-sm">{a.content}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {a.sender.name ?? a.sender.email} ·{" "}
                  {new Date(a.created_at).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface EventMessagingProps {
  eventId: string
}

export function EventMessaging({ eventId }: EventMessagingProps) {
  const [tab, setTab] = useState<MessagingTab>("announcements")

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as MessagingTab)}
      >
        <TabsList className="w-fit">
          <TabsTrigger value="announcements">Announcements</TabsTrigger>
          <TabsTrigger value="polls">Polls</TabsTrigger>
          <TabsTrigger value="sponsored">Sponsored</TabsTrigger>
        </TabsList>
        <TabsContent value="announcements">
          <AnnouncementsPanel eventId={eventId} />
        </TabsContent>
        <TabsContent value="polls" className="flex flex-col gap-3 pt-2">
          <p className="text-xs leading-5 text-muted-foreground">
            A poll lands in the room like any other message. Counts stay hidden
            until enough people have voted — in a room of six, one vote against a
            named option identifies that person to everyone still in it.
          </p>
          <PollComposer eventId={eventId} />
        </TabsContent>
        <TabsContent value="sponsored">
          <SponsoredMessagesPanel eventId={eventId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
