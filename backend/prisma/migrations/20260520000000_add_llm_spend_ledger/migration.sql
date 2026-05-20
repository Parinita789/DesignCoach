-- Phase 3, commit 3.1: per-user LLM spend ledger. One row per
-- successful LLM call; CostCapService.assertWithinCap sums these
-- since UTC midnight to decide whether the next call is allowed.

CREATE TABLE "llm_spend" (
  "id"                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"              UUID         NOT NULL,
  "occurred_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "provider"             TEXT         NOT NULL,
  "model"                TEXT         NOT NULL,
  "tokens_in"            INTEGER      NOT NULL,
  "tokens_out"           INTEGER      NOT NULL,
  "cache_read_tokens"    INTEGER      NOT NULL DEFAULT 0,
  "cache_creation_tokens" INTEGER     NOT NULL DEFAULT 0,
  "estimated_cost_usd"   DECIMAL(10, 6) NOT NULL,
  "route"                TEXT         NOT NULL
);

ALTER TABLE "llm_spend"
  ADD CONSTRAINT "llm_spend_user_id_fkey"
  FOREIGN KEY ("user_id")
  REFERENCES "users"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Compound index for the hot path: "sum of today's spend for user X"
-- = WHERE user_id = ? AND occurred_at >= utc_midnight()
CREATE INDEX "llm_spend_user_id_occurred_at_idx"
  ON "llm_spend" ("user_id", "occurred_at");
