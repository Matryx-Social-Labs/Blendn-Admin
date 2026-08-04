"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

interface ModerationFlag {
  id: string
  messageId: string
  userId: string
  userName: string | null
  userEmail: string
  source: string
  status: string
  categories: Record<string, number>
  confidence: number
  autoAction: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  reviewNotes: string | null
  createdAt: string
  message: {
    id: string
    content: string
    type: string
    createdAt: string
    isDeleted: boolean
  }
}

interface ModerationStats {
  pending: number
  autoHidden: number
  total: number
}

interface ModerationQueueProps {
  eventId: string
}

export function ModerationQueue({ eventId }: ModerationQueueProps) {
  const [flags, setFlags] = useState<ModerationFlag[]>([])
  const [stats, setStats] = useState<ModerationStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [filter, setFilter] = useState<"pending" | "all" | "approved" | "rejected">("pending")
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  const fetchFlags = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      try {
        const res = await fetch(
          `/api/events/${eventId}/chat/moderation?status=${filter}&page=${page}&limit=20`,
          { signal }
        )
        const json = await res.json()
        if (signal?.aborted) return
        if (json.success) {
          setFlags(json.data.flags)
          setStats(json.data.stats)
          setTotalPages(json.data.pagination.totalPages)
        }
      } catch (err) {
        // An abort is this effect superseding itself, not a failure.
        if ((err as Error)?.name === "AbortError") return
        toast.error("Failed to load moderation queue")
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [eventId, filter, page]
  )

  useEffect(() => {
    // Without this, flipping filters quickly lets an older response land after
    // a newer one and show an admin the wrong moderation queue.
    const controller = new AbortController()
    void fetchFlags(controller.signal)
    return () => controller.abort()
  }, [fetchFlags])

  const handleReview = async (flagId: string, action: "approve" | "reject") => {
    setActionLoading(flagId)
    try {
      const res = await fetch(
        `/api/events/${eventId}/chat/moderation/${flagId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      )
      const json = await res.json()
      if (json.success) {
        toast.success(
          action === "approve"
            ? "Message restored (false positive)"
            : "Message kept hidden"
        )
        fetchFlags()
      } else {
        toast.error(json.error || "Failed to review flag")
      }
    } catch {
      toast.error("Failed to review flag")
    } finally {
      setActionLoading(null)
    }
  }

  const sourceLabel = (source: string) => {
    switch (source) {
      case "auto_keyword": return "Keyword"
      case "auto_text": return "AI Text"
      case "auto_image": return "AI Image"
      case "auto_spam": return "Spam"
      case "user_report": return "Report"
      default: return source
    }
  }

  const confidenceColor = (confidence: number) => {
    if (confidence >= 0.85) return "destructive"
    if (confidence >= 0.5) return "secondary"
    return "outline"
  }

  return (
    <div className="flex flex-col h-full">
      {/* Stats bar */}
      {stats && (
        <div className="flex gap-4 px-4 py-3 border-b text-sm">
          <span>
            Pending: <strong>{stats.pending}</strong>
          </span>
          <span>
            Auto-hidden: <strong>{stats.autoHidden}</strong>
          </span>
          <span>
            Total: <strong>{stats.total}</strong>
          </span>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 px-4 py-2 border-b">
        {(["pending", "all", "approved", "rejected"] as const).map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "ghost"}
            size="sm"
            onClick={() => { setFilter(f); setPage(1) }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>

      {/* Flag list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            Loading...
          </div>
        ) : flags.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            No {filter === "all" ? "" : filter} flags found
          </div>
        ) : (
          <div className="divide-y">
            {flags.map((flag) => (
              <div key={flag.id} className="px-4 py-3 space-y-2">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant={confidenceColor(flag.confidence) as "destructive" | "secondary" | "outline"}>
                      {(flag.confidence * 100).toFixed(0)}%
                    </Badge>
                    <Badge variant="outline">{sourceLabel(flag.source)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {flag.userName || flag.userEmail}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(flag.createdAt).toLocaleString()}
                  </span>
                </div>

                {/* Message content */}
                <div className="rounded bg-muted p-2 text-sm">
                  <p className={flag.message.isDeleted ? "line-through text-muted-foreground" : ""}>
                    {flag.message.content}
                  </p>
                </div>

                {/* Categories */}
                <div className="flex gap-1 flex-wrap">
                  {Object.entries(flag.categories as Record<string, number>).map(
                    ([cat, score]) => (
                      <Badge key={cat} variant="outline" className="text-xs">
                        {cat}: {(score as number * 100).toFixed(0)}%
                      </Badge>
                    )
                  )}
                </div>

                {/* Actions */}
                {flag.status === "pending" ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionLoading === flag.id}
                      onClick={() => handleReview(flag.id, "approve")}
                    >
                      Restore (False Positive)
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={actionLoading === flag.id}
                      onClick={() => handleReview(flag.id, "reject")}
                    >
                      Keep Hidden
                    </Button>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    {flag.status === "approved" ? "Approved" : "Rejected"}
                    {flag.reviewedAt && ` on ${new Date(flag.reviewedAt).toLocaleString()}`}
                    {flag.reviewNotes && ` — ${flag.reviewNotes}`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 border-t">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Prev
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
