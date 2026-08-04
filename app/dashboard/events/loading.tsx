import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  TableSkeleton,
} from "@/components/dashboard/page-skeleton"

export default function Loading() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <PageHeaderSkeleton />
      <StatCardsSkeleton />
      <TableSkeleton rows={8} columns={6} />
    </div>
  )
}
