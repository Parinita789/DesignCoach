# Schema relationship diagram

Reference for the data model defined in `schema.prisma`. Update this file
when adding/removing tables or changing cardinalities. The diagram below
is the rendered SVG export of the Mermaid source that follows it — keep
the two in sync when you edit the schema.

## ER diagram

![Interview Assistant ER diagram](./schema.svg)

<details>
<summary>Mermaid source (click to expand)</summary>

```mermaid
erDiagram
    Question ||--o{ Session : "Session.question_id → Question.id"
    Session  ||--o{ Snapshot : "Snapshot.session_id → Session.id"
    Session  ||--o{ PhaseEvaluation : "PhaseEvaluation.session_id → Session.id"
    Session  ||--o{ AIInteraction : "AIInteraction.session_id → Session.id"
    Session  ||--o| FinalArtifacts : "FinalArtifacts.session_id → Session.id (PK+FK)"
    PhaseEvaluation ||--o| EvaluationAudit : "EvaluationAudit.phase_evaluation_id → PhaseEvaluation.id (UNIQUE)"
    PhaseEvaluation ||--o| MentorArtifact : "MentorArtifact.phase_evaluation_id → PhaseEvaluation.id (UNIQUE)"
    PhaseEvaluation ||--o| SignalMentorArtifact : "SignalMentorArtifact.phase_evaluation_id → PhaseEvaluation.id (UNIQUE)"

    Question {
        uuid id PK
        text prompt
        text rubric_version
        enum mode "build|design (NULL on v1.0 questions)"
        timestamp created_at
    }

    Session {
        uuid id PK
        uuid question_id FK
        text project_path
        timestamp started_at
        timestamp ended_at
        enum status "active|completed|abandoned"
        enum seniority "junior|mid|senior|staff (NULL on v1.0)"
        decimal overall_score
        text overall_feedback
    }

    Snapshot {
        uuid id PK
        uuid session_id FK
        timestamp taken_at
        int elapsed_minutes
        text inferred_phase
        json artifacts "planMd lives here"
        json judge_note
    }

    PhaseEvaluation {
        uuid id PK
        uuid session_id FK
        enum phase "plan|build|validate|wrap"
        decimal score
        json signal_results
        text feedback_text
        json top_actionable_items
        timestamp evaluated_at
    }

    EvaluationAudit {
        uuid id PK
        uuid phase_evaluation_id FK "UNIQUE"
        text prompt "rendered LLM input"
        text raw_response "LLM text pre-parse"
        text model_used
        int tokens_in
        int tokens_out
        int cache_read_tokens
        int cache_creation_tokens
        int latency_ms "wall-clock LLM call duration (NULL for pre-2026-05-04 rows)"
        timestamp created_at
    }

    MentorArtifact {
        uuid id PK
        uuid phase_evaluation_id FK "UNIQUE"
        text content "Markdown — 6-section deep-dive teaching artifact"
        text model_used
        int tokens_in
        int tokens_out
        int cache_read_tokens
        int cache_creation_tokens
        int latency_ms
        timestamp created_at
        timestamp updated_at
    }

    SignalMentorArtifact {
        uuid id PK
        uuid phase_evaluation_id FK "UNIQUE"
        jsonb annotations "{signal_id → coaching string} for gap signals only"
        text model_used
        int tokens_in
        int tokens_out
        int cache_read_tokens
        int cache_creation_tokens
        int latency_ms
        timestamp created_at
        timestamp updated_at
    }

    AIInteraction {
        uuid id PK
        uuid session_id FK
        timestamp occurred_at
        int elapsed_minutes
        text inferred_phase
        text prompt
        text response
        text model_used
        int tokens_in
        int tokens_out
        json artifact_state_at_prompt
    }

    FinalArtifacts {
        uuid session_id PK,FK
        text plan_md
        text git_log
        text ai_prompts_log
        text reflection
        json code_files
    }
```

</details>

## Relationships

Each row reads "child.foreign_key → parent.primary_key" — that's the column
linkage Postgres uses to enforce the relationship.

| Edge | Cardinality | Join (child FK → parent PK) | onDelete | Why |
| --- | --- | --- | --- | --- |
| Question → Session | 1 : N | `sessions.question_id` → `questions.id` | `Restrict` | Don't lose attempts; deleting a Question requires explicit cleanup of its sessions first. |
| Session → Snapshot | 1 : N | `snapshots.session_id` → `sessions.id` | `Cascade` | Snapshots are session-scoped logs. |
| Session → PhaseEvaluation | 1 : N | `phase_evaluations.session_id` → `sessions.id` | `Cascade` | Re-evaluate creates a new row; history retained per session. |
| Session → AIInteraction | 1 : N | `ai_interactions.session_id` → `sessions.id` | `Cascade` | Hint chat log. |
| Session → FinalArtifacts | 1 : 0..1 | `final_artifacts.session_id` → `sessions.id` (also PK on the child, which enforces 0..1) | `Cascade` | Optional snapshot of the session's final output (one per session). |
| PhaseEvaluation → EvaluationAudit | 1 : 0..1 | `evaluation_audits.phase_evaluation_id` → `phase_evaluations.id` (UNIQUE on child, which enforces 0..1) | `Cascade` | One audit per evaluation. Deleting an evaluation drops its audit. |
| PhaseEvaluation → MentorArtifact | 1 : 0..1 | `mentor_artifacts.phase_evaluation_id` → `phase_evaluations.id` (UNIQUE on child) | `Cascade` | Optional 6-section mentor reflection per evaluation. Fired in the background after eval persists. |
| PhaseEvaluation → SignalMentorArtifact | 1 : 0..1 | `signal_mentor_artifacts.phase_evaluation_id` → `phase_evaluations.id` (UNIQUE on child) | `Cascade` | Optional per-signal coaching map — `{signal_id → annotation}` populated only for gap signals (missed-good, fired-bad). Fired in the background after eval persists. |

## Design highlights

- **Question vs Session split**: Question = the problem
  (prompt + rubric version), Session = one attempt. A Question owns N
  attempts; the most recent `plan.md` is copied forward into a new attempt
  via the "Try again" path.
- **EvaluationAudit is a sibling, not a parent**, of `PhaseEvaluation`:
  parsed output (score, signals, feedback) stays lean on the main table;
  the heavy prompt/raw-response text lives only in the audit table. Cascade
  keeps them aligned without bloating the hot path.
- **No upsert on PhaseEvaluation.** Each Re-evaluate inserts a new row.
  The `(session_id, phase, evaluated_at DESC)` index makes "latest plan
  eval for session X" a single seek; nothing is ever overwritten.
- **JSON columns vs relational rows.** `signal_results` and `artifacts` are
  JSON because their shape is rubric-driven and varies across versions.
  Anything queried directly (status, scores, foreign keys) is a typed
  column.
