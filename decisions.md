# Architectural Decisions — Interview Assistant

This document captures the *why* behind key architectural choices. For the *what* and *how* of building, see `plan.md`.

---

## 1. Tech Stack

### Decision: NestJS (Node.js, TypeScript) for backend

### Decision: PostgreSQL with JSONB columns for storage

**Why:**
- Data is fundamentally relational: sessions have snapshots, sessions have evaluations, evaluations have signal results.
- JSONB handles the variable-shape parts (signal results, artifacts) without schema migrations every time the rubric changes.
- Foreign keys with cascading deletes prevent orphaned data.
- SQL window functions and aggregations make the dashboard queries (trends, heatmaps) trivial.
- Boring, well-understood, easy to debug at 11pm.

**Alternatives rejected:**
- MongoDB: data is relational, document size limits would bite as snapshots accumulate, aggregation pipelines harder to maintain than SQL.
- SQLite: works for personal use but breaks if dashboard is ever accessed from another device. Migration cost outweighs savings.

---

### Decision: React + Tailwind + Recharts + Monaco Editor for frontend

**Why:**
- React is the default, well-supported choice.
- Tailwind for fast styling without CSS file management.
- Recharts handles the trend chart and heatmap with minimal code.
- Monaco editor for writing `plan.md` directly inside the active-session page (autosaved every 5 min, plus `sendBeacon` flush on tab close). **Superseded — see §8.** Read-only mode also used in the audit modal to display the rendered prompt + raw LLM response.

---

### Decision: Anthropic Claude API as the primary LLM provider — *now via a factory with two alternates*

**Why:**
- Matches the user's actual workflow (Claude Code in VS Code).
- Same model family for evaluation as for the AI interactions being evaluated reduces interpretation gaps.
- Strong instruction-following for structured rubric scoring; prompt caching cuts repeat-call cost.

**Now factored:** `LlmProviderFactory` returns one of three providers based on env (`anthropic.provider.ts`, `ollama.provider.ts`, `claude-cli.provider.ts`). All implement `LlmProvider`. Selection priority:
1. `LLM_PROVIDER=claude_cli` → spawns `claude -p` (uses the user's logged-in Claude Code session, no API key needed)
2. `ANTHROPIC_API_KEY` set → Anthropic SDK
3. otherwise → Ollama (`OLLAMA_BASE_URL` + `OLLAMA_MODEL`)

The Anthropic provider is the only one that supports prompt caching and tool-use forcing. The other two flatten structured system blocks into a single string and fall back to the legacy JSON-in-prose path.

---

## 2. Workflow Integration

### Decision: Tool hosts the editor and an in-tool Socratic-coach hint panel

**Pivoted from:** "*Tool observes the user's project directory; does NOT host the editor.*"

**Why the pivot:**
- The "real Claude Code experience" pivot assumed a JSONL-parsing pipeline that turned out to be more complexity than it was worth for a single user. Phase inference from file activity is a non-trivial heuristic; tying evaluation to Claude Code's log format coupled the tool to one IDE.
- Hosting the editor lets the rubric inspect *exactly* what the candidate wrote, with no parser fragility. Monaco supports markdown, autosave is trivial, and the active-session UI can render the question + a hint chat side by side.
- A small in-tool hint chat (Socratic coach, see `hints/`) replaces the "use Claude Code while we watch" model. The chat is optional; users who prefer to think alone simply don't open it.
- The `phase-tagger/` module and `JsonlEntry` types remain in the codebase as stubs for a future revisit, but no production path uses them today.

**Implication:**
- `ActiveSessionPage` renders a Monaco editor for `plan.md` plus a `HintChatPanel`. Snapshots autosave the editor's content every 5 min and on tab close (`sendBeacon`).
- `AIInteractionsRepository` stores hint-chat turns directly; no JSONL parsing.
- Phase inference is currently scoped to "plan" only — the only phase agent that actually runs.

---

## 3. Evaluation Architecture

### Decision: Multi-agent evaluation with phase-specialist agents + synthesizer

**Status:** Architecture in place; only `PlanAgent` is fully implemented. `BuildAgent`, `ValidateAgent`, `WrapAgent`, and `SynthesizerAgent` are stub classes that satisfy the DI graph but return placeholder results. The plan-phase evaluation is the entire production path today.

**Why (still valid):**
- Each phase's rubric is large enough that giving an agent only its phase's rubric (rather than all four) produces sharper scoring.
- Phase agents run in parallel — 4 calls simultaneously have roughly the same wall-clock time as 1 call.
- Independent failure: if one agent fails, the others still produce results; synthesizer notes the gap.
- Easier rubric iteration: tuning the planning rubric only requires changing one agent's prompt.

**Target architecture:**
```
End of session
  ├── Plan Agent       (parallel)  ← only this one runs today
  ├── Build Agent      (parallel)  (stub)
  ├── Validate Agent   (parallel)  (stub)
  └── Wrap Agent       (parallel)  (stub)
       ↓
  Synthesizer Agent (sequential, after all 4 complete)  (stub)
```

**Limit:**
- Not going further into multi-agent within a phase (e.g., separate "scope agent" inside planning). The rubric is small enough that one agent per phase handles it cleanly. More agents = more coordination overhead = diminishing returns.

---

### Decision: In-process Promise.all orchestration, not a queue

**Why:**
- Single user, bounded workload, known set of agents — none of the conditions that make queues valuable.
- Backend orchestrator fires LLM calls in parallel via `Promise.all`, awaits all, then runs synthesizer.
- Adding a queue (Redis, SQS, BullMQ) would be over-engineering at this scale.

**Agent <-> orchestrator transport:**
- The phase agents and synthesizer are NestJS singletons in the same Node process. `await agent.evaluate(...)` is an in-process method call; the returned `PhaseEvaluationResult` is an object reference in the same V8 heap, not an HTTP response.
- The only HTTP on the evaluation path is each agent's outbound call to the Anthropic API. Inputs (artifacts, tagged JSONL entries, rubric) are gathered once by the orchestrator and passed to each agent by reference — no copying, no serialization.

**When this would change:**
- Multiple users with backpressure needs.
- Per-call latency exceeding HTTP timeout (>60s).
- Need for distributed agents across machines.

---

### Decision: Synchronous end-of-session evaluation (single call)

**Pivoted from:** "*Async polling pattern — `POST /sessions/:id/end` returns immediately, frontend polls `GET /evaluations/:id/status`.*"

**Why the pivot:**
- Only one phase agent runs today (Plan), so the wall-clock budget is one Anthropic call (3–10s with caching). That's well under HTTP timeout.
- Polling adds frontend complexity (query loops, cancel-on-unmount, intermediate UI) for no win at this latency.
- `POST /sessions/:id/end` now returns `EndSessionResult { session, evaluations[], evalError }` directly. The frontend awaits the response and routes to `SessionResultsPage`.
- The async pattern can return when the build/validate/wrap agents come online and the wall-clock budget grows. The status endpoint (`GET /evaluations/:id/status`) is preserved as a stub returning `{ state: 'complete' }`.

---

## 4. Real-Time Capture

### Decision: Client-side timer driving 5-minute snapshot captures

**Why:**
- Single user — server-side timers add complexity (websockets, reconnection, server-side scheduling) for no benefit.
- Browser `setInterval` triggers a POST to the backend every 5 min.
- localStorage persists `session_id` and `started_at` to survive tab close.

**Limit:**
- If the tab is closed for >5 min, the snapshot for that interval is missed. Acceptable for personal use; would need server-side scheduling for production.

---

### Decision: Snapshots capture text artifacts only, not screenshots

**Why:**
- Screenshots cost ~50-200KB each, scale badly across sessions.
- Vision OCR at evaluation time is slow and expensive.
- Screenshots are noisy (window chrome, cursor, irrelevant pixels).
- Text artifacts (file contents, git log, JSONL entries) capture everything the judge actually needs.

**What gets captured per snapshot:**
1. Current state of plan.md and code files
2. Git log if repo exists
3. New Claude Code JSONL entries since last snapshot
4. Elapsed time and inferred current phase

**Storage:** ~5-50KB per snapshot, ~12 snapshots per 1hr session, ~500KB per session total. Trivially storable.

---

## 5. Database Schema

### Decision: 7 tables, with JSONB for variable-shape data

**Pivoted from:** 5 tables. `questions` was split out from `sessions` (see §8) and `evaluation_audit` was added to capture every LLM call's prompt + raw response 1:1 with each `phase_evaluation`.

**Tables:**
- `questions` (the practice prompt — owns N attempts; `rubric_version` and `mode` are frozen here)
- `sessions` (one attempt at a `question`; `seniority` is per-attempt — see §9)
- `snapshots` (time-series during session)
- `phase_evaluations` (per-phase scoring at session end; current path stores plan-phase only)
- `evaluation_audit` (1:1 with `phase_evaluations`; full rendered prompt, raw response, model, token + cache counts)
- `ai_interactions` (in-tool hint chat turns; replaces the earlier "parsed from JSONL" plan)
- `final_artifacts` (final state at session end)

### Decision: JSONB for `signal_results`, `artifacts`, etc., not full normalization

**Why:**
- Rubric signals change over time as the rubric iterates. Each rubric change in a normalized schema would require migrations.
- Read patterns are "show me everything for this evaluation," not "find all evaluations of signal X across sessions" — the second query is rare.
- GIN indexes on JSONB make cross-session signal queries fast enough when needed.

**When to revisit:**
- If cross-session signal-trend queries become the dominant access pattern, consider a derived view or projection table.

---

### Decision: Foreign keys with `ON DELETE CASCADE`

**Why:**
- Deleting a session should clean up its snapshots, evaluations, interactions, and artifacts atomically.
- Postgres enforces this at the storage layer — no application-level cleanup logic needed.

---

## 6. Scope Boundaries (v1)

### Decisions about what NOT to build:

> **Update (production-hardening, 2026-05).** The "no auth / no
> multi-user" stance below is now obsolete. Phases 1–3 of the
> production-hardening plan shipped: JWT auth + per-row ownership
> (User model, `Question.userId`, `Session.userId`, global
> AuthGuard), per-tier rate limiting (`@nestjs/throttler` with named
> tiers + per-user tracker), and per-user daily LLM cost cap
> (`LlmSpend` ledger + `CostCapService.assertWithinCap` wrapping
> every `LlmService.call`). See the engineering-highlights section
> of the README for the surface, and `backend/prisma/SCHEMA.md` for
> the schema shape.


- **No real-time *judge* interruptions during the session.** The grading agent is silent until the user ends the session. **Note:** there *is* an in-tool Socratic-coach hint chat (`HintChatPanel`) that replies to user questions during the session — this is a coach, not the judge. The judge never sees the chat output until evaluation time.
- **No cross-session memory in the judge.** Each session evaluated independently. Trend analysis happens in the dashboard, not the judge.
- **No support for AI tools other than the configured LLM provider.** Originally scoped to Claude Code only; broadened to "whichever provider the env selects" via the factory. Still no multi-vendor abstraction beyond Anthropic / Ollama / Claude CLI.
- **No hosted deployment.** Local-only for v1. Render/Railway later if cross-device access becomes useful.
- **No rubric editing UI.** Rubrics live as YAML files in the codebase. Editing is a code change. Avoids building a CMS for a single user.
- **No editing seniority or mode after session creation.** Both are frozen at the first attempt's start. To re-evaluate at a different level, the user uses the "Retry as: [Junior][Mid][Senior][Staff]" picker, which creates a new sibling attempt.

---

## 7. Rubric Versioning

### Decision: Store `rubric_version` on each `question` row (per-question, not per-session)

**Pivoted from:** "*on each session row.*" Multiple attempts at the same question must share the same rubric — comparing attempt 1 (v1.0) vs. attempt 2 (v2.0) of the same question would be apples-to-oranges. So `rubric_version` and `mode` live on `questions`; `seniority` lives on `sessions` (see §9).

**Why:**
- Rubrics will iterate. A question evaluated under v1.0 should remain comparable only to other v1.0 questions.
- Trend charts in the dashboard filter by rubric version to avoid comparing apples to oranges across rubric changes.
- Old sessions are not re-evaluated when the rubric changes — historical scores are preserved as-is.

---

## 8. Question vs. Session split

### Decision: Split `Question` from `Session` so retries share a question but get their own attempt

**Why:**
- Originally a session WAS the practice unit, with the prompt embedded in it. Retrying the same question meant duplicating the prompt — comparisons across attempts had to join on a free-text field.
- The split makes "retry this question" a first-class flow: a `Question` owns N `Session` rows. Score deltas across attempts are a SQL `ORDER BY started_at` away.
- The "Try again" button copies the most recent session's `plan.md` into the new attempt as a starting point — so the user iterates rather than starting blank.

**Implications:**
- `rubric_version` and `mode` live on `questions` (frozen across attempts).
- `seniority` lives on `sessions` (the user can retry the same question at a different seniority).
- The Attempts dropdown on the results page shows `[seniority chip] · [score] · [date]` per row.

---

## 9. v2.0 rubric: build / design variants + per-attempt seniority calibration

### Decision: Single rubric file → shared core + per-mode variants + per-signal seniority weights

**Pivoted from:** `v1.0/plan.yaml` (one file, no mode, no seniority).

**Why:**
- A "build a counter" question and a "design Twitter" question stress different signals. Asking the LLM to classify the question and then conditionally apply the rubric burned tokens and produced inconsistent classifications. Splitting into `plan.build.yaml` and `plan.design.yaml` (both `extends:` `plan.shared.yaml`) makes the variant a routing decision at session creation time, not an LLM judgment call.
- A junior practicing isn't usefully scored against the same bar as a staff candidate. Per-signal `weight_by_seniority` shifts (e.g., `capacity_estimation: { junior: low, senior: high }`) calibrate the score band by level. `RubricLoaderService.load(version, phase, mode, seniority)` resolves the effective weight at load time, so downstream code sees a single resolved `weight`.
- Anchors stay seniority-agnostic — only weights shift. Threshold table is unchanged. The scoring ratio is calibrated by level *by construction* because both numerator and denominator scale together.

**Alternatives rejected:**
- 4 × 2 = 8 separate rubric files per `(seniority, mode)`. Most signal definitions duplicate verbatim; per-signal `weight_by_seniority` solves the same need with one source of truth.
- Threshold-table shifts per seniority. Per-signal weight resolution shifts max_score and good_score in lockstep, so a threshold shift on top would over-correct.
- Auto-detecting seniority from the prompt. Low signal — the prompt rarely says "as a junior, design X." User-pick is the authoritative input.

---

## 10. Hallucination guardrails

The rubric is only as good as the LLM's output structure. Three layers, each catching a different failure mode:

### Decision: Forced tool-call output (Anthropic only)

**Why:**
- The original "return JSON matching this schema" prose prompt let three failure modes through: invented signal IDs, dropped required signals, and malformed JSON. The post-hoc `parseEvalOutput` parser handled malformed JSON resiliently (fence-stripping, balanced `{…}` extraction) but couldn't catch the structural errors.
- Anthropic tool-use with `tool_choice: {type: 'tool', name: 'submit_evaluation'}` makes those failure modes structurally impossible: `additionalProperties: false` rejects unknown signal IDs, `required: [...allSignalIds]` rejects missing ones, the schema enforces top-level shape.
- `properties` order is `reasoning → result → evidence` per signal. Anthropic models emit args in declared order, so the model writes its reasoning *before* committing to a verdict — a cheap chain-of-thought-before-result that empirically improves calibration.
- `temperature: 0` on the plan-phase call makes verdicts reproducible across re-runs.

**Implementation:**
- `plan-tool-schema.ts` builds the tool dynamically from the loaded rubric.
- `validate-eval-tool-args.ts` belt-and-suspenders validates the parsed input shape (defense against SDK regressions).
- Ollama and Claude CLI providers ignore `tools`/`toolChoice` and fall through to the legacy JSON-in-prose path; the plan agent branches on `response.toolUse` to pick the right parser.

### Decision: Evidence validator (all providers)

**Why:**
- Tool-use prevents the model from inventing signal IDs but doesn't stop it from inventing *quotes* — putting fabricated text in the `evidence` field with a valid signal ID.
- `validateEvidence` ground-checks every HIT/PARTIAL evidence string against `plan.md` + the user's hint-chat history. Sliding 30-character match with a 5-word-gram fallback handles light paraphrasing without false positives.
- Ungrounded evidence triggers an automatic verdict downgrade: HIT → PARTIAL, PARTIAL → MISS. The annotation `[unverifiable evidence: <kind> → <kind>]` is appended to the evidence string so the failure is visible in the audit.

### Decision: Deterministic score (always)

**Why:**
- Even with a constrained schema, the model's *score* number drifts: it pattern-matches against the anchor scenarios instead of computing the threshold-table ratio. Asking it to score and then trusting that score reintroduces variance.
- `computeScore` ignores anything the LLM said about the score. It applies per-signal weights, the paired good ↔ bad rule (don't double-count), the threshold table (`ratio ≥ 0.85 ∧ no high-weight miss → 5`, etc.), and critical-signal caps (`code_before_plan` caps at 2).
- A warn-level log fires when the LLM-emitted score and the deterministic score disagree by ≥ 1, useful for spotting rubric/anchor drift.

---

## 11. Audit trail (1:1 with each evaluation)

### Decision: Capture every LLM call's full prompt + raw response in `evaluation_audit`

**Why:**
- A score that the user can't trace is unactionable. The audit modal on the results page lazy-loads the audit row when the user clicks "View prompt" — the full rendered system + user messages, the tool schema (when tool-use is in effect), the raw structured args (or text response), the model used, token counts, cache hit/miss tokens.
- Lets the user see exactly what the LLM saw and what it said, byte-for-byte. Catches "the model got my prompt wrong" hallucinations and "the rubric is misleading the model" calibration bugs.
- 10–80KB per audit row; lazy-loaded so the results page stays cheap.

---

## 12. Module layout and cross-cutting concerns

### Decision: Per-module `dto/` + `types/` + `prompts/` + `validators/` + `agents/` + `services/`

**Pivoted from:** A single `models/` folder per module that mixed DTOs and pure TS types, plus `services/agents/` that mixed Nest providers with pure helpers.

**Why:**
- `models/` was misleading — it implied ORM models, but the actual DB models live in `prisma/schema.prisma`. The folder ended up as a catch-all for both `*.dto.ts` (HTTP request shapes validated with class-validator) and `*.types.ts` (pure TS shapes). Splitting clarifies intent: DTOs are for boundary validation, types are for everywhere.
- `services/agents/` accumulated non-`@Injectable` files (prompt builders, parsers, mode classifiers) next to the actual agent classes. Hoisting them out into role-specific siblings (`prompts/`, `validators/`, `helpers/`) makes "what is this module's actual surface" obvious from the file tree.
- Implementation contracts (`*.interface.ts`) live in their own files because multiple classes implement them. Pure data types with many consumers live in shared `types/*.types.ts` so consumers don't import from a producer's file path. File-private types stay co-located.

### Decision: Global `AllExceptionsFilter` for unhandled errors

**Why:**
- Controllers were duplicating `try { … } catch { logger.error(…); throw new HttpException(…) }`. Centralizing this in `common/filters/all-exceptions.filter.ts` keeps controllers focused on routing.
- The filter passes `HttpException` (e.g., `NotFoundException`) through unchanged — it only normalizes truly unhandled errors to `{ message: 'Internal server error', error: <message> }` with the stack trace logged.
- Wired via `app.useGlobalFilters(new AllExceptionsFilter())` in `main.ts`.

---

## Open Decisions (To Revisit After v1)

- Whether to add per-snapshot LLM notes (cheap calls during session, builds time-series of judge observations) or skip them and rely on retrospective evaluation only.
- Whether to add a "manual narration" input where the user types short notes during the session.
- Whether to support hybrid Claude Code + external AI tools (e.g., Claude.ai chat for sparring on plan).
- Whether to fork the rubric per problem type (e.g., LLM-systems vs. distributed-systems vs. data-pipelines) or keep one universal rubric.
- Whether to bring `BuildAgent` / `ValidateAgent` / `WrapAgent` online (the multi-agent orchestration is wired but only `PlanAgent` produces results today). Likely waits until the in-tool editor expands beyond `plan.md`.
- Whether to revive the JSONL phase-tagger path now that the in-tool editor is the primary surface — useful if users ever want to practice in their own VS Code + Claude Code and import the artifacts post-hoc.
- Whether to surface `signalResults[*].reasoning` in the UI (currently captured by the tool-use path and persisted in the JSON column, but not displayed). Useful for debugging; cluttered for normal use.
- Whether to migrate v1.0 sessions to v2.0 by re-evaluation. Currently they stay v1.0 with `mode = seniority = null`; the chevron-retry-as-different-seniority flow doesn't apply to them.