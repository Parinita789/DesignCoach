-- Adds input_fingerprint to phase_evaluations so a re-evaluate with
-- identical inputs (plan.md content + model + build artifacts) returns
-- the cached row instead of paying for a fresh LLM run.
--
-- Nullable on existing rows: pre-migration rows didn't compute a
-- fingerprint, so they'll never cache-hit. The next re-evaluate on
-- those sessions inserts a row with a real fingerprint and subsequent
-- re-evaluates with identical inputs hit the cache.
--
-- The partial UNIQUE index enforces "at most one row per
-- (session, phase, fingerprint)" — concurrent re-evaluations with the
-- same inputs both pass the cache check and run their LLM calls, but
-- only one INSERT succeeds. The orchestrator catches P2002 and
-- returns the winner's row.

ALTER TABLE "phase_evaluations"
  ADD COLUMN "input_fingerprint" CHAR(64);

CREATE UNIQUE INDEX "phase_evaluations_session_phase_fingerprint_uniq"
  ON "phase_evaluations" ("session_id", "phase", "input_fingerprint")
  WHERE "input_fingerprint" IS NOT NULL;
