"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  IconTrash,
  IconBan,
  IconRefresh,
  IconUser,
  IconVolume3,
  IconChevronDown,
  IconChevronRight,
  IconAlertTriangle,
  IconShieldCheck,
} from "@tabler/icons-react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  content: string
  type: string
  createdAt: string
  user: {
    id: string
    anonymousName: string | null
    /*
     * Present only for app_admin — the API omits real identity for organisers
     * and venue owners so event chat stays genuinely pseudonymous. Optional
     * here rather than `string | null` so that rendering `user.name` without
     * checking the role fails to typecheck instead of silently showing a blank
     * to hosts and the real name to admins.
     */
    name?: string | null
    email?: string
    image?: string | null
  }
}

interface Violation {
  source: string
  categories: Record<string, number>
  confidence: number
  autoAction: string | null
  createdAt: string
  messageContent: string | null
}

interface ChatMember {
  userId: string
  anonymousName: string | null
  status: string
  bannedAt: string | null
  bannedByName: string | null
  mutedAt: string | null
  violationCount: number
  recentViolations: Violation[]
}

interface ChatFeedData {
  chatGroupId: string
  messages: ChatMessage[]
  members: ChatMember[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  auto_keyword: "Keyword",
  auto_text: "AI Text",
  auto_image: "AI Image",
  auto_spam: "Spam",
  user_report: "Report",
  manual: "Manual",
}

const SOURCE_COLORS: Record<string, string> = {
  auto_keyword: "bg-red-500/10 text-red-400 border-red-500/20",
  auto_text: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  auto_image: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  auto_spam: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  user_report: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  manual: "bg-gray-500/10 text-gray-400 border-gray-500/20",
}

function topCategory(categories: Record<string, number>): string | null {
  let top: string | null = null
  let max = 0
  for (const [key, val] of Object.entries(categories)) {
    if (val > max) {
      max = val
      top = key
    }
  }
  return top
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ChatFeedProps {
  eventId: string
}

export function ChatFeed({ eventId }: ChatFeedProps) {
  const [data, setData] = useState<ChatFeedData | null>(null)
  const [loading, setLoading] = useState(true)
  /*
   * Whether the last load failed, as distinct from having nothing to show.
   *
   * Without this a 403 rendered as "No chatroom for this event yet." — a
   * failure explained as an absence, and the wrong absence at that. An
   * organiser who had lost access to a room was told the room did not exist.
   */
  const [failed, setFailed] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"messages" | "members">("messages")
  const [expandedUser, setExpandedUser] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isFirstLoad = useRef(true)

  const fetchData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const res = await fetch(`/api/events/${eventId}/chat/messages`, { cache: "no-store" })
      if (!res.ok) {
        /*
         * A failed poll keeps whatever is on screen — the messages were real
         * when they arrived — but it must not be silent. This refreshes every
         * five seconds, so without a flag a room that has started refusing
         * simply freezes, and the last good render is indistinguishable from a
         * quiet room.
         */
        setFailed(true)
        return
      }
      setFailed(false)
      {
        const json = await res.json() as ChatFeedData
        setData(json)
        if (isFirstLoad.current) {
          isFirstLoad.current = false
          setTimeout(() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
          }, 100)
        }
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    void fetchData()
    const interval = setInterval(() => void fetchData(true), 5000)
    return () => clearInterval(interval)
  }, [fetchData])

  const deleteMessage = async (messageId: string) => {
    if (!confirm("Delete this message?")) return
    setActionLoading(messageId)
    try {
      const res = await fetch(`/api/events/${eventId}/chat/messages/${messageId}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      setData((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== messageId) }
          : prev
      )
      toast.success("Message deleted")
    } catch {
      toast.error("Failed to delete message")
    } finally {
      setActionLoading(null)
    }
  }

  const memberAction = async (userId: string, action: "ban" | "unban" | "mute" | "unmute") => {
    const labels = { ban: "Ban", unban: "Unban", mute: "Mute", unmute: "Unmute" }
    if (!confirm(`${labels[action]} this user?`)) return
    setActionLoading(`action-${userId}`)
    try {
      const res = await fetch(`/api/events/${eventId}/chat/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error()

      const statusMap = { ban: "banned", unban: "active", mute: "muted", unmute: "active" }
      setData((prev) =>
        prev
          ? {
              ...prev,
              members: prev.members.map((m) =>
                m.userId === userId
                  ? {
                      ...m,
                      status: statusMap[action],
                      bannedAt: action === "ban" ? new Date().toISOString() : action === "unban" ? null : m.bannedAt,
                      mutedAt: action === "mute" ? new Date().toISOString() : action === "unmute" ? null : m.mutedAt,
                    }
                  : m
              ),
            }
          : prev
      )
      toast.success(`User ${action === "ban" ? "banned" : action === "unban" ? "unbanned" : action === "mute" ? "muted" : "unmuted"}`)
    } catch {
      toast.error("Failed to update member status")
    } finally {
      setActionLoading(null)
    }
  }

  const bannedMembers = data?.members.filter((m) => m.status === "banned") ?? []
  const mutedMembers = data?.members.filter((m) => m.status === "muted") ?? []
  const activeMembers = data?.members.filter((m) => m.status === "active") ?? []
  const restrictedCount = bannedMembers.length + mutedMembers.length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div>
          <h2 className="font-semibold text-sm">Live Chat Feed</h2>
          <p className="text-xs text-muted-foreground">
            {data ? `${data.messages.length} messages · ${activeMembers.length} active · ${restrictedCount} restricted` : "Loading\u2026"}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void fetchData()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
        >
          <IconRefresh className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Tab switcher */}
      <div className="flex border-b shrink-0">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setActiveTab("messages")}
          className={`flex-1 py-2 h-auto rounded-none text-xs font-medium transition-colors ${
            activeTab === "messages"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Messages
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setActiveTab("members")}
          className={`flex-1 py-2 h-auto rounded-none text-xs font-medium transition-colors ${
            activeTab === "members"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Members
          {restrictedCount > 0 && (
            <span className="ml-1 rounded-full bg-destructive/10 text-destructive text-xs px-1.5">
              {restrictedCount}
            </span>
          )}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && !data ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Loading chat\u2026</p>
          </div>
        ) : failed && !data ? (
          <div className="flex items-center justify-center h-full p-6 text-center">
            <p className="text-sm text-muted-foreground">
              That feed did not load. It may not be yours to read.
            </p>
          </div>
        ) : !data?.chatGroupId ? (
          <div className="flex items-center justify-center h-full p-6 text-center">
            <p className="text-sm text-muted-foreground">No chatroom for this event yet.</p>
          </div>
        ) : activeTab === "messages" ? (
          <div className="p-3 space-y-1">
            {data.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No messages yet.</p>
            ) : (
              data.messages.map((msg) => {
                const member = data.members.find((m) => m.userId === msg.user.id)
                const isBanned = member?.status === "banned"
                const isMuted = member?.status === "muted"
                return (
                  <div
                    key={msg.id}
                    className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors ${
                      isBanned || isMuted ? "opacity-50" : ""
                    }`}
                  >
                    <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                      <IconUser className="size-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <span className="text-xs font-medium truncate">
                          {msg.user.anonymousName ?? "Attendee"}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {new Date(msg.createdAt).toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {isBanned && (
                          <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">
                            banned
                          </Badge>
                        )}
                        {isMuted && (
                          <Badge className="text-[10px] px-1 py-0 h-4 bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
                            muted
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm leading-snug break-words">{msg.content}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void deleteMessage(msg.id)}
                        disabled={actionLoading === msg.id}
                        title="Delete message"
                        aria-label="Delete message"
                      >
                        <IconTrash className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void memberAction(msg.user.id, isBanned ? "unban" : "ban")}
                        disabled={actionLoading === `action-${msg.user.id}`}
                        title={isBanned ? "Unban user" : "Ban user"}
                      >
                        <IconBan className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
            <div ref={bottomRef} />
          </div>
        ) : (
          /* Members tab */
          <div className="p-3 space-y-4">
            {/* ── Banned Members ── */}
            {bannedMembers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <IconBan className="size-4 text-destructive" />
                  <p className="text-xs font-semibold text-destructive uppercase tracking-wide">
                    Banned ({bannedMembers.length})
                  </p>
                </div>
                <div className="space-y-2">
                  {bannedMembers.map((m) => (
                    <RestrictedMemberCard
                      key={m.userId}
                      member={m}
                      type="banned"
                      isExpanded={expandedUser === m.userId}
                      onToggleExpand={() => setExpandedUser(expandedUser === m.userId ? null : m.userId)}
                      onAction={(action) => void memberAction(m.userId, action)}
                      actionLoading={actionLoading === `action-${m.userId}`}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Muted Members ── */}
            {mutedMembers.length > 0 && (
              <div>
                {bannedMembers.length > 0 && <Separator className="mb-4" />}
                <div className="flex items-center gap-2 mb-2">
                  <IconVolume3 className="size-4 text-yellow-500" />
                  <p className="text-xs font-semibold text-yellow-500 uppercase tracking-wide">
                    Muted ({mutedMembers.length})
                  </p>
                </div>
                <div className="space-y-2">
                  {mutedMembers.map((m) => (
                    <RestrictedMemberCard
                      key={m.userId}
                      member={m}
                      type="muted"
                      isExpanded={expandedUser === m.userId}
                      onToggleExpand={() => setExpandedUser(expandedUser === m.userId ? null : m.userId)}
                      onAction={(action) => void memberAction(m.userId, action)}
                      actionLoading={actionLoading === `action-${m.userId}`}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── No restricted message ── */}
            {bannedMembers.length === 0 && mutedMembers.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-3">
                <IconShieldCheck className="size-4 text-green-500 shrink-0" />
                <p className="text-xs text-green-400">No banned or muted users in this chat.</p>
              </div>
            )}

            {(bannedMembers.length > 0 || mutedMembers.length > 0) && <Separator />}

            {/* ── Active Members ── */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Active ({activeMembers.length})
              </p>
              <div className="space-y-1.5">
                {activeMembers.map((m) => (
                  <div
                    key={m.userId}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 group hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm truncate">{m.anonymousName ?? "Attendee"}</p>
                      {m.violationCount > 0 && (
                        <span className="flex items-center gap-0.5 text-[10px] text-yellow-500">
                          <IconAlertTriangle className="size-3" />
                          {m.violationCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 text-yellow-500 hover:text-yellow-500 hover:bg-yellow-500/10"
                        onClick={() => void memberAction(m.userId, "mute")}
                        disabled={actionLoading === `action-${m.userId}`}
                      >
                        <IconVolume3 className="size-3.5 mr-1" />
                        Mute
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 text-destructive hover:text-destructive"
                        onClick={() => void memberAction(m.userId, "ban")}
                        disabled={actionLoading === `action-${m.userId}`}
                      >
                        <IconBan className="size-3.5 mr-1" />
                        Ban
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t shrink-0">
        <p className="text-[10px] text-muted-foreground">Auto-refreshes every 5 seconds</p>
      </div>
    </div>
  )
}

// ── Restricted Member Card ────────────────────────────────────────────────────

interface RestrictedMemberCardProps {
  member: ChatMember
  type: "banned" | "muted"
  isExpanded: boolean
  onToggleExpand: () => void
  onAction: (action: "ban" | "unban" | "mute" | "unmute") => void
  actionLoading: boolean
}

function RestrictedMemberCard({
  member,
  type,
  isExpanded,
  onToggleExpand,
  onAction,
  actionLoading,
}: RestrictedMemberCardProps) {
  const isBanned = type === "banned"
  const borderColor = isBanned ? "border-destructive/20" : "border-yellow-500/20"
  const bgColor = isBanned ? "bg-destructive/5" : "bg-yellow-500/5"
  const dateStr = isBanned ? member.bannedAt : member.mutedAt

  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} overflow-hidden`}>
      {/* Header row */}
      <Button
        type="button"
        variant="ghost"
        onClick={onToggleExpand}
        aria-label={isExpanded ? "Collapse member details" : "Expand member details"}
        className="w-full h-auto justify-between px-3 py-2.5 text-left font-normal hover:bg-muted/20 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded ? (
            <IconChevronDown className="size-3.5 text-muted-foreground shrink-0" />
          ) : (
            <IconChevronRight className="size-3.5 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{member.anonymousName ?? "Attendee"}</p>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              {dateStr && (
                <span>
                  {isBanned ? "Banned" : "Muted"} {new Date(dateStr).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
              {member.bannedByName && isBanned && (
                <span>by {member.bannedByName}</span>
              )}
              {member.violationCount > 0 && (
                <span className="text-yellow-500">{member.violationCount} violation{member.violationCount !== 1 ? "s" : ""}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {isBanned ? (
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7"
              onClick={() => onAction("unban")}
              disabled={actionLoading}
            >
              Unban
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7"
                onClick={() => onAction("unmute")}
                disabled={actionLoading}
              >
                Unmute
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => onAction("ban")}
                disabled={actionLoading}
              >
                Ban
              </Button>
            </>
          )}
        </div>
      </Button>

      {/* Expanded: violation history */}
      {isExpanded && member.recentViolations.length > 0 && (
        <div className="border-t border-border/50 px-3 py-2 space-y-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Recent Violations
          </p>
          {member.recentViolations.map((v, i) => (
            <div key={i} className="rounded border border-border/50 bg-background/50 px-2.5 py-2 space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 h-4 ${SOURCE_COLORS[v.source] ?? SOURCE_COLORS.manual}`}
                >
                  {SOURCE_LABELS[v.source] ?? v.source}
                </Badge>
                <span className={`text-[10px] font-medium ${
                  v.confidence >= 0.85 ? "text-red-400" : v.confidence >= 0.5 ? "text-yellow-400" : "text-muted-foreground"
                }`}>
                  {Math.round(v.confidence * 100)}% confidence
                </span>
                {v.autoAction === "hidden" && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-red-500/10 text-red-400 border-red-500/20">
                    Auto-hidden
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {new Date(v.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              {v.messageContent && (
                <p className="text-xs text-muted-foreground line-clamp-2 italic">
                  &ldquo;{v.messageContent}&rdquo;
                </p>
              )}
              {v.categories && Object.keys(v.categories).length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  {Object.entries(v.categories)
                    .filter(([, val]) => val > 0.1)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cat, val]) => (
                      <span
                        key={cat}
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          topCategory(v.categories) === cat
                            ? "bg-red-500/15 text-red-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {cat}: {Math.round(val * 100)}%
                      </span>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Expanded but no violations */}
      {isExpanded && member.recentViolations.length === 0 && (
        <div className="border-t border-border/50 px-3 py-3">
          <p className="text-xs text-muted-foreground">
            {isBanned ? "Manually banned by admin — no auto-detected violations." : "No recorded violations."}
          </p>
        </div>
      )}
    </div>
  )
}
