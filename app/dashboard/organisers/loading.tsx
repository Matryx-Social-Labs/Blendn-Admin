import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  TableSkeleton,
} from "@/components/dashboard/page-skeleton"

export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeaderSkeleton />
      <StatCardsSkeleton count={2} />
      <TableSkeleton rows={6} columns={5} />
    </div>
  )
}
