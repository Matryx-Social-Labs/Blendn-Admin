-- One approved claim per event.
--
-- `20260824120000_curated_events` added partial uniques on PENDING claims and
-- stopped there, which is H13 in the register reproduced in the third instance
-- of the claim pattern -- the one the plan says should close it rather than
-- inherit it.
--
-- Without this, two admins approving competing claims on one event both
-- succeed. `decideEventClaim` re-reads `claimRefusal` before the transaction,
-- so both see `claimed_at IS NULL`, both pass, and both commit: two rows say
-- `approved`, the event belongs to whichever transaction committed last, and
-- the losing organisation is told they got it. A check outside the transaction
-- is not a lock, and the database is the only thing that can serialise this.
--
-- `superseded` is deliberately outside the predicate: that is the state the
-- losers are moved to inside the same transaction, and it must stay unbounded.
CREATE UNIQUE INDEX "event_claims_one_approved_per_event"
  ON "event_claims" ("event_id")
  WHERE "status" = 'approved';
