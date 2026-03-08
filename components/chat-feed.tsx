"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { IconTrash, IconBan, IconRefresh, IconUser } from "@tabler/icons-react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  content: string
  type: string
  createdAt: string
  user: {
    id: string
    name: string | null
    email: string
    image: string | null
    anonymousName: string | null
  }
}

interface ChatMember {
  userId: string
  anonymousName: string | null
  status: string
  bannedAt: string | null
}

interface ChatFeedData {
  chatGroupId: string
  messages: ChatMessage[]
  members: ChatMember[]
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ChatFeedProps {
  eventId: string
}

export function ChatFeed({ eventId }: ChatFeedProps) {
  const [data, setData] = useState<ChatFeedData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"messages" | "members">("messages")
  const bottomRef = useRef<HTMLDivElement>(null)
  const isFirstLoad = useRef(true)

  const fetchData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const res = await fetch(`/api/events/${eventId}/chat/messages`, { cache: "no-store" })
      if (res.ok) {
        const json = await res.json() as ChatFeedData
        setData(json)
        if (isFirstLoad.current) {
          isFirstLoad.current = false
          // Scroll to bottom on first load
          setTimeout(() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
          }, 100)
        }
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [eventId])

  // Initial load + poll every 5 seconds
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

  const toggleBan = async (userId: string, currentStatus: string) => {
    const action = currentStatus === "banned" ? "unban" : "ban"
    if (!confirm(`${action === "ban" ? "Ban" : "Unban"} this user from the chat?`)) return
    setActionLoading(`ban-${userId}`)
    try {
      const res = await fetch(`/api/events/${eventId}/chat/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error()
      setData((prev) =>
        prev
          ? {
              ...prev,
              members: prev.members.map((m) =>
                m.userId === userId
                  ? { ...m, status: action === "ban" ? "banned" : "active", bannedAt: action === "ban" ? new Date().toISOString() : null }
                  : m
              ),
            }
          : prev
      )
      toast.success(action === "ban" ? "User banned from chat" : "User unbanned")
    } catch {
      toast.error("Failed to update member status")
    } finally {
      setActionLoading(null)
    }
  }

  const bannedMembers = data?.members.filter((m) => m.status === "banned") ?? []
  const activeMembers = data?.members.filter((m) => m.status !== "banned") ?? []

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div>
          <h2 className="font-semibold text-sm">Live Chat Feed</h2>
          <p className="text-xs text-muted-foreground">
            {data ? `${data.messages.length} messages · ${activeMembers.length} members` : "Loading…"}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void fetchData()}
          disabled={loading}
          title="Refresh"
        >
          <IconRefresh className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Tab switcher */}
      <div className="flex border-b shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab("messages")}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            activeTab === "messages"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Messages
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("members")}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            activeTab === "members"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Members
          {bannedMembers.length > 0 && (
            <span className="ml-1 rounded-full bg-destructive/10 text-destructive text-xs px-1.5">
              {bannedMembers.length}
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && !data ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Loading chat…</p>
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
                const isBanned = data.members.find((m) => m.userId === msg.user.id)?.status === "banned"
                return (
                  <div
                    key={msg.id}
                    className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors ${
                      isBanned ? "opacity-50" : ""
                    }`}
                  >
                    {/* Avatar placeholder */}
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
                      </div>
                      <p className="text-sm leading-snug break-words">{msg.content}</p>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void deleteMessage(msg.id)}
                        disabled={actionLoading === msg.id}
                        title="Delete message"
                      >
                        <IconTrash className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          void toggleBan(
                            msg.user.id,
                            data.members.find((m) => m.userId === msg.user.id)?.status ?? "active"
                          )
                        }
                        disabled={actionLoading === `ban-${msg.user.id}`}
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
          <div className="p-3 space-y-3">
            {bannedMembers.length > 0 && (
              <>
                <div>
                  <p className="text-xs font-medium text-destructive mb-2">
                    Banned ({bannedMembers.length})
                  </p>
                  <div className="space-y-1.5">
                    {bannedMembers.map((m) => (
                      <div
                        key={m.userId}
                        className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2"
                      >
                        <div>
                          <p className="text-sm font-medium">{m.anonymousName ?? "Attendee"}</p>
                          {m.bannedAt && (
                            <p className="text-xs text-muted-foreground">
                              Banned {new Date(m.bannedAt).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7"
                          onClick={() => void toggleBan(m.userId, "banned")}
                          disabled={actionLoading === `ban-${m.userId}`}
                        >
                          Unban
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
                <Separator />
              </>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Active ({activeMembers.length})
              </p>
              <div className="space-y-1.5">
                {activeMembers.map((m) => (
                  <div
                    key={m.userId}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 group hover:bg-muted/30 transition-colors"
                  >
                    <p className="text-sm">{m.anonymousName ?? "Attendee"}</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => void toggleBan(m.userId, "active")}
                      disabled={actionLoading === `ban-${m.userId}`}
                    >
                      <IconBan className="size-3.5 mr-1" />
                      Ban
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer: auto-refresh indicator */}
      <div className="px-4 py-2 border-t shrink-0">
        <p className="text-[10px] text-muted-foreground">Auto-refreshes every 5 seconds</p>
      </div>
    </div>
  )
}
