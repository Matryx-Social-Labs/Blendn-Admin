-- SCRUM-352: organisers add unclaimed venues. The organisation whose member
-- added a venue may edit it while it is unclaimed. Additive: existing rows stay
-- null (admin-only while unclaimed, as before).
-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "created_by_org_id" UUID;

-- CreateIndex
CREATE INDEX "venues_created_by_org_id_idx" ON "venues"("created_by_org_id");

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_created_by_org_id_fkey" FOREIGN KEY ("created_by_org_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

