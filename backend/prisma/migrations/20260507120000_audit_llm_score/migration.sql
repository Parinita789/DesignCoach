-- The score the LLM proposed in its tool/JSON output, before deterministic
-- re-computation. PhaseEvaluation.score holds the deterministic value we
-- trust; this column captures the raw LLM-claimed score so prompt drift,
-- calibration error, and rubric weighting bugs become queryable as
-- `abs(eval.score - audit.llm_score)`. Nullable so legacy rows stay valid.

ALTER TABLE "evaluation_audits" ADD COLUMN "llm_score" DECIMAL(3, 2);
