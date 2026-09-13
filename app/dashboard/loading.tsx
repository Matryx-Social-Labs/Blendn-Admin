import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  TableSkeleton,
} from "@/components/dashboard/page-skeleton"

export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeaderSkeleton />
      <StatCardsSkeleton />
      <TableSkeleton rows={5} columns={4} />
    </div>
  )
}
