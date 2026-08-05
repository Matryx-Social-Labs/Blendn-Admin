"use client"

import { useCallback, useEffect, useState } from "react"
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
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  IconBell,
  IconBrandSpeedtest,
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
}

interface Announcement {
  id: string
  content: string
  created_at: string
  sender: { name: string | null; email: string }
}

// ── Quick templates ───────────────────────────────────────────────────────────

const QUICK_TEMPLATES = [
  "Bar closing in 30 minutes — grab your last orders!",
  "Car owners, please check the parking area for any blocking vehicles.",
  "Stage performance starting in 10 minutes — don't miss it!",
  "Restrooms are located near the main entrance.",
  "Lost & found is at the help desk near gate 1.",
  "Event wrapping up in 15 minutes. Thank you for joining us!",
]

// ── Sponsored Messages Panel ──────────────────────────────────────────────────

function SponsoredMessagesPanel({ eventId }: { eventId: string }) {
  const [messages, setMessages] = useState<SponsoredMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)

  // New / edit form state
  const [formContent, setFormContent] = useState("")
  const [formInterval, setFormInterval] = useState("30")
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/sponsored-messages`)
      if (res.ok) setMessages(await res.json())
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { void fetchMessages() }, [fetchMessages])

  const openAdd = () => {
    setEditingId(null)
    setFormContent("")
    setFormInterval("30")
    setShowForm(true)
  }

  const openEdit = (msg: SponsoredMessage) => {
    setEditingId(msg.id)
    setFormContent(msg.content)
    setFormInterval(String(msg.interval_minutes))
    setShowForm(true)
  }

  const cancelForm = () => {
    setShowForm(false)
    setEditingId(null)
    setFormContent("")
  }

  const save = async () => {
    if (!formContent.trim()) return toast.error("Message content is required")
    try {
      setSaving(true)
      const url = editingId
        ? `/api/events/${eventId}/sponsored-messages/${editingId}`
        : `/api/events/${eventId}/sponsored-messages`
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formContent, interval_minutes: Number(formInterval) }),
      })
      if (!res.ok) throw new Error()
      toast.success(editingId ? "Message updated" : "Sponsored message created")
      cancelForm()
      await fetchMessages()
    } catch {
      toast.error("Failed to save message")
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
      if (!res.ok) throw new Error()
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, is_active: !m.is_active } : m))
      )
      toast.success(msg.is_active ? "Stopped" : "Started sending")
    } catch {
      toast.error("Failed to update")
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
          <h3 className="font-semibold flex items-center gap-2">
            <IconBrandSpeedtest className="size-4 text-blue-500" />
            Sponsored Messages
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pre-written messages sent automatically to the chatroom at a set interval.
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
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1">Send every</p>
              <Select value={formInterval} onValueChange={setFormInterval}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 minutes</SelectItem>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">60 minutes</SelectItem>
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
                  {msg.last_sent_at && (
                    <span className="text-xs text-muted-foreground">
                      Last sent {new Date(msg.last_sent_at).toLocaleTimeString()}
                    </span>
                  )}
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

// ── Announcements Panel ───────────────────────────────────────────────────────

function AnnouncementsPanel({ eventId }: { eventId: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [content, setContent] = useState("")
  const [sending, setSending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [audience, setAudience] = useState({ members: 0, reachable: 0 })

  const fetchAnnouncements = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/announcements`)
      if (res.ok) {
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
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text)
      }
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
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <IconBell className="size-4 text-amber-500" />
          Send Announcement
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Instantly push a message to the event chatroom — shown with an Announcement badge.
        </p>
      </div>

      {/* Quick templates */}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_TEMPLATES.map((t) => (
          <Button
            key={t}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setContent(t)}
            className="rounded-full text-left text-xs"
          >
            {t.length > 50 ? t.slice(0, 50) + "…" : t}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        <Textarea
          placeholder="Type your announcement…"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        {/*
          The blast radius, before the send rather than after it.
          An announcement pushes a notification to every attendee's phone — the
          most powerful and most abusable thing a host can do — and this was a
          textarea with one button and no indication of how many people that
          was. The confirm names the number, and the number is distinct people
          who will actually get a notification, not chatroom members.
        */}
        {confirming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
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
          <Button
            onClick={() => setConfirming(true)}
            disabled={sending || !content.trim()}
            className="w-full"
          >
            Send Announcement
          </Button>
        )}
        <p className="text-[0.6875rem] text-muted-foreground">
          Limited to 3 per minute. Attendees see the sender as the event host, never your name.
        </p>
      </div>

      <Separator />

      {/* History */}
      <div>
        <p className="text-sm font-medium mb-2">Recent Announcements</p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : announcements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No announcements sent yet.</p>
        ) : (
          <div className="space-y-2">
            {announcements.map((a) => (
              <div key={a.id} className="rounded-lg border bg-amber-50 dark:bg-amber-950/20 p-3">
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
  eventTitle: string
}

export function EventMessaging({ eventId, eventTitle }: EventMessagingProps) {
  const [tab, setTab] = useState<"announcements" | "sponsored">("announcements")

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Messaging</h2>
        <p className="text-sm text-muted-foreground">
          Manage announcements and sponsored messages for{" "}
          <span className="font-medium">{eventTitle}</span>
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "announcements" | "sponsored")}
      >
        <TabsList className="w-fit">
          <TabsTrigger value="announcements">Announcements</TabsTrigger>
          <TabsTrigger value="sponsored">Sponsored</TabsTrigger>
        </TabsList>
        <TabsContent value="announcements">
          <AnnouncementsPanel eventId={eventId} />
        </TabsContent>
        <TabsContent value="sponsored">
          <SponsoredMessagesPanel eventId={eventId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
