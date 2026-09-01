import { PageHeaderSkeleton, TableSkeleton } from "@/components/dashboard/page-skeleton"

/**
 * Both screens are `force-dynamic` and make three or four round trips, so
 * without this the previous page sits frozen until the server answers. Five
 * other dashboard sections already have one; these two were the exception.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5 py-4">
      <PageHeaderSkeleton />
      <TableSkeleton rows={6} columns={4} />
    </div>
  )
}
