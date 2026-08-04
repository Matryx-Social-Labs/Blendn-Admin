import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

const STAT_CARD_COUNT = 4
const TABLE_COLUMN_COUNT = 9
const TABLE_ROW_COUNT = 6

export default function UsersLoading() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <div className="rounded-xl border bg-card px-6 py-6">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {Array.from({ length: STAT_CARD_COUNT }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="size-4 rounded-full" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="px-4 lg:px-6">
        <div className="rounded-xl border bg-card p-5">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-9 max-w-sm flex-1" />
              <Skeleton className="h-9 w-24" />
            </div>
            <div className="overflow-hidden rounded-lg border">
              <div className="flex border-b bg-muted px-4 py-3">
                {Array.from({ length: TABLE_COLUMN_COUNT }).map((_, i) => (
                  <Skeleton key={i} className="mr-4 h-4 flex-1" />
                ))}
              </div>
              {Array.from({ length: TABLE_ROW_COUNT }).map((_, rowIdx) => (
                <div key={rowIdx} className="flex items-center px-4 py-4">
                  {Array.from({ length: TABLE_COLUMN_COUNT }).map((_, colIdx) => (
                    <Skeleton key={colIdx} className="mr-4 h-4 flex-1" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
