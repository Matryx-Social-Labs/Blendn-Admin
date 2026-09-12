import { StatCardsSkeleton, TableSkeleton } from "@/components/dashboard/page-skeleton"

export default function UsersLoading() {
  return (
    <div className="flex flex-col gap-5">
      <StatCardsSkeleton count={4} />
      <TableSkeleton rows={6} columns={6} />
    </div>
  )
}
