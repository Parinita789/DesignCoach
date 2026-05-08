-- One row per turn captured from a Claude Code conversation log
-- (~/.claude/projects/<encodedCwd>/*.jsonl) during the build phase.
-- Truncated at the CLI before shipping (text ≤ 4 KB, tool result ≤ 1 KB).
-- The composite unique index lets the backend silently dedupe
-- re-shipped turns via createMany({ skipDuplicates: true }) when the
-- CLI's cursor file is wiped or out of sync.

CREATE TABLE "build_ai_interactions" (
    "id"                    UUID NOT NULL,
    "session_id"            UUID NOT NULL,
    "tool"                  TEXT NOT NULL,
    "external_session_id"   TEXT NOT NULL,
    "turn_index"            INTEGER NOT NULL,
    "role"                  TEXT NOT NULL,
    "text"                  TEXT,
    "tool_name"             TEXT,
    "tool_input_summary"    TEXT,
    "tool_result_summary"   TEXT,
    "occurred_at"           TIMESTAMP(3) NOT NULL,
    "received_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_ai_interactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "build_ai_interactions_session_id_external_session_id_turn_index_key"
    ON "build_ai_interactions"("session_id", "external_session_id", "turn_index");

CREATE INDEX "build_ai_interactions_session_id_occurred_at_idx"
    ON "build_ai_interactions"("session_id", "occurred_at");

ALTER TABLE "build_ai_interactions"
    ADD CONSTRAINT "build_ai_interactions_session_id_fkey"
    FOREIGN KEY ("session_id")
    REFERENCES "sessions"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
