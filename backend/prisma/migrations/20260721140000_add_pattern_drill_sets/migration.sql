CREATE TABLE "pattern_drill_sets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "covered_patterns" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "submission" JSONB,
    "graded_result" JSONB,
    "submitted_at" TIMESTAMP(3),

    CONSTRAINT "pattern_drill_sets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pattern_drill_sets_user_id_created_at_idx" ON "pattern_drill_sets"("user_id", "created_at");

ALTER TABLE "pattern_drill_sets" ADD CONSTRAINT "pattern_drill_sets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
