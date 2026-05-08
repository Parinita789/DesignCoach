-- Topics directly relevant to the question that the candidate either
-- missed or only lightly touched. Empty array on legacy rows.
ALTER TABLE "phase_evaluations"
  ADD COLUMN "gap_topics" jsonb NOT NULL DEFAULT '[]'::jsonb;
