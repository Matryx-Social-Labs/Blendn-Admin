import { TableSkeleton } from "@/components/dashboard/page-skeleton"

export default function Loading() {
  return <TableSkeleton rows={3} columns={3} />
}
