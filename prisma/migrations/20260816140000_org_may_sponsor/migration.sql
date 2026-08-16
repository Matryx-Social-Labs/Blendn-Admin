-- May this organisation mark a broadcast as `sponsored`?
--
-- Off for everyone, including existing rows. "Sponsored" is a claim that
-- somebody paid, and the word is only worth having if it is scarce -- so the
-- migration grants it to nobody and an admin turns it on per organisation.
--
-- An org-level flag rather than a role: the permission belongs to the company
-- with the commercial agreement, not to whichever of its staff is logged in.
ALTER TABLE "organisations" ADD COLUMN "may_sponsor" BOOLEAN NOT NULL DEFAULT false;
