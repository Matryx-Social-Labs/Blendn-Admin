import { OwnedHeaderSkeleton, TableSkeleton } from "@/components/dashboard/page-skeleton"

/** An owned header's route (`OWNED_HEADERS`): the layout draws no header here. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <OwnedHeaderSkeleton />
      <TableSkeleton rows={6} columns={5} />
    </div>
  )
}
