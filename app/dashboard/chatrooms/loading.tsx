import {
  PageHeaderSkeleton,
  StatCardsSkeleton,
  CardGridSkeleton,
} from "@/components/dashboard/page-skeleton"

export default function Loading() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <PageHeaderSkeleton />
      <StatCardsSkeleton count={3} />
      <CardGridSkeleton count={6} />
    </div>
  )
}
