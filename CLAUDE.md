# CLAUDE.md

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Codebase shape

Three runnable packages, each independently testable:

- `backend/` — NestJS 10 / Prisma / PostgreSQL / BullMQ on Redis. 20 modules. Owns rubrics
  (under `backend/rubrics/v*/`) + the eval harness (`backend/eval-harness/`).
- `frontend/` — React 18 + Vite + Monaco + TanStack Query. Auth state in
  Zustand. Talks to backend at `VITE_API_BASE_URL` (default proxies to :3000).
- `cli/` — `mentor watch` for agentic_build sessions. Buffers events to
  local SQLite + ships to backend.
- `agents/` — static analysis tooling (NOT a runtime). Generates module
  maps, knowledge graphs, schema/architecture diagrams. Outputs land
  under `agents/data/`; the single-page hub is `agents/HUB.html`.

## Common commands

### Backend
```bash
cd backend
npm install
cp .env.example .env             # ANTHROPIC_API_KEY OR LLM_PROVIDER=claude_cli;
                                 # JWT_SECRET (openssl rand -hex 32);
                                 # LLM_DAILY_CAP_USD (default $5)
npx prisma migrate deploy        # apply schema
npm run start:dev                # http://localhost:3000/api, watch-rebuild
npm test                         # full Jest unit suite
npx jest <path>                  # one file
npx jest -t "<regex>"            # by test name
npm run test:e2e                 # e2e suite (Postgres test DB — see backend/test/README.md)
npm run lint                     # eslint --fix
npx tsc --noEmit                 # type-check
```

### Frontend
```bash
cd frontend
npm install
npm run dev                      # http://localhost:5173
npm run build                    # tsc -b && vite build
npm run lint                     # eslint, fails on warnings
npx tsc --noEmit                 # type-check
```

### CLI
```bash
cd cli
npm install && npm run build && npm link
mentor --help
```

### Eval harness (real LLM regression suite)
```bash
cd backend
npm run eval:plan                # PlanAgent against every plan fixture
npm run eval:build               # BuildAgent against build fixtures
npm run eval:all                 # everything
npm run eval:plan -- --filter=<substring>           # one fixture
npm run eval:plan -- --compare-monolithic           # A/B split vs reconstructed monolithic; ~doubles cost
LLM_TIMEOUT_MS=240000 npm run eval:plan -- ...      # bump per-attempt timeout (default 90s)
```

Provider selection follows `backend/.env` (`LLM_PROVIDER`). Each fixture
asserts a score band + per-signal verdicts; pass/fail is `signalsOk &&
scoreOk`. See `backend/eval-harness/README.md`.

## Architecture

The user journey through a single eval crosses every layer; understanding
that flow makes the rest of the codebase obvious.

### Backend module DAG

Modules under `backend/src/modules/` form an explicit DAG — **no
`forwardRef` anywhere** (see Project conventions below). Three patterns
break cycles:

1. **Extract a leaf data module.** `session-read/` and
   `build-sessions-data/` exist so the orchestrator can read a session
   without depending on `sessions/` (which depends on most of the world).
2. **Reverse the edge with a queue job.** The orchestrator enqueues
   `mentor` / `signal-mentor` jobs through the leaf `evaluation-queue/`
   module; the workers live in `mentor/workers/` and
   `signal-mentor/workers/`, so the orchestrator never imports them.
3. **Reverse the edge with an event.** `EvaluationCompletedEvent` and
   `PlanEvalDetailsCompletedEvent` (in `backend/src/common/events/`)
   notify in-process listeners such as the dashboard feedback
   projection. See `@OnEvent` decorators.

### Evaluation queue

All evaluation work runs as BullMQ jobs on Redis (`REDIS_URL`, or
`REDIS_HOST`/`REDIS_PORT`). `evaluation-queue/` owns one queue per job
type (`plan-score`, `plan-details`, `build-evaluation`, `mentor`,
`signal-mentor`): 3 attempts, exponential backoff, failed jobs retained.
Job IDs are deterministic (`session + model + fingerprint` for phase
jobs, `evaluationId` for follow-ups), so re-enqueuing an active job is a
no-op. Every job is mirrored to the `evaluation_jobs` table, which the
frontend and status endpoints read. `BackgroundTaskTracker` is only for
loss-tolerant in-process work (artifact cleanup, feedback projection).
See `decisions.md` §3.

### LLM provider factory

`LlmProviderFactory.resolveName()` (in `backend/src/modules/llm/`) honors
`LLM_PROVIDER` as a first-class enum: `claude_cli` (subscription, free,
spawns CLI subprocess) | `anthropic` (SDK, paid) | `ollama` (offline).
Unset falls back to the legacy heuristic (API key ⇒ anthropic). Unknown
values throw. Dev uses `claude_cli`; prod uses `anthropic`. Provider is
transparent to callers — `LlmService.call(messages, opts)` is the single
entry point and wraps every provider in:

- **Per-attempt timeout via AbortController** — `LLM_TIMEOUT_MS` default 90s.
  On abort the signal propagates into the provider (claude_cli child
  SIGKILL, fetch abort, SDK signal) so a timeout doesn't leak a still-
  running call.
- **Exponential-backoff retry** on `LlmTimeoutError`, 5xx, 429.
- **Cost cap** when `opts.userId && opts.route` are both set:
  `assertWithinCap(userId)` pre-flight + `record(...)` post-success. The
  ledger (`llm_spend`) is indexed `(user_id, occurred_at)` and prices
  per-provider (claude_cli / ollama = $0, anthropic = real).

The claude_cli provider uses `--output-format stream-json --verbose` and
logs each event (`system init`, `assistant #N`, `result received`) so a
long-running call is observable instead of silent.

### Plan eval is a two-call split

`PlanAgent` does NOT extend `BasePhaseAgent`. It exposes two methods:

- **`evaluateResults(input)`** — Call A. Tool: `submit_plan_results`.
  Returns per-signal verdicts only (hit/partial/miss/cannot_evaluate).
  Score computed deterministically by `score-computer.ts` from verdicts.
  ~5-15s on opus.
- **`evaluateDetails(input, priorSignalResults)`** — Call B. Tool:
  `submit_plan_details`. Grounds on Call A's verdicts via "Known
  per-signal verdicts" preamble in the user prompt. Returns evidence per
  signal + feedback + top_actions + gap_topics. Runs evidence validator
  (which may downgrade signals + re-compute score) and returns the
  finalized payload. ~30-90s on opus.

`POST /sessions/:sessionId/evaluate` (and session end) only enqueues a
`plan-score` job and returns `{ status: 'queued', jobIds }`. The
`PlanScoreWorker` calls `OrchestratorService.run`, which skips the LLM
entirely if an eval with the same input fingerprint exists. Otherwise
`runPlanPhase` persists the Call A row, emits `EvaluationCompletedEvent`,
and enqueues `signal-mentor` + `plan-details` jobs. `PlanDetailsWorker`
runs Call B via `runPlanDetailsForEvaluation`; on success the row is
patched via `EvaluationsRepository.patchDetails`, a `mentor` job is
enqueued (deep-dive mentor), and `PlanEvalDetailsCompletedEvent` fires.
On Call B failure (timeout, cost-cap, parse error), the row gets
`details_error` via `markDetailsError` and the error is rethrown so
BullMQ retries; a later successful attempt overwrites it.

**Call B's prompt is verbatim-quote-sensitive.** The evidence validator
checks every quoted snippet against `plan.md` + hint history by 30-char
window + 5-word n-gram match. Paraphrasing fails the check and
downgrades the signal (hit→partial→miss), which changes the score. Don't
loosen the validator; do tighten the prompt if a model variant starts
paraphrasing. See `backend/src/modules/evaluations/prompts/plan-prompt.ts`
and the `Output (Call B)` block.

**Build eval is still the legacy single-call shape.** `BuildAgent.evaluate`
runs the monolithic schema; the orchestrator's `runBuildPhase` is
unchanged. Two-call refactor for build is deferred.

### Frontend polling pattern

`evalsQuery` (`frontend/src/pages/SessionResults/SessionResultsPage.tsx`)
uses `refetchInterval` to poll every 3s while the most-recent plan row
has neither `detailsCompletedAt` nor `detailsError` AND is younger than
5min, and while an eval was queued but no newer row exists yet.
Stops once one of them lands. `evaluationJobsQuery` polls
`GET /sessions/:id/evaluation-jobs` every 3s while any job is `queued`
or `running`. `PlanEvaluationView` renders score +
signals immediately from Call A; `DetailsPendingSkeleton` placeholders
fill the feedback/top_actions/gap_topics slots until Call B patches the
row, or an amber banner shows the `detailsError`. Signal-mentor + deep-
dive mentor use the same poll-on-404 pattern.

### Auth + ownership

- **Global `AuthGuard`** via `APP_GUARD` makes every route authed by
  default. Opt-out via `@Public()` (signup/login) or `@CliAuthenticated()`
  (CLI ingest with a build token instead of a JWT).
- **`OwnershipService.assertOwns{Session,Question,Evaluation}`** is
  inlined on hot read paths — controllers call it explicitly before
  delegating to the service. Avoids a second DB round-trip per request.

### Cost cap

- **Pre-call gate**: `CostCapService.assertWithinCap(userId)` sums
  `llm_spend.estimated_cost_usd` since UTC midnight; if ≥ `LLM_DAILY_CAP_USD`
  (default $5), throws → HTTP 403 with `code: COST_CAP_EXCEEDED` +
  `resetAtUtc`.
- **Post-call ledger**: every successful `LlmService.call` writes one
  `llm_spend` row with provider-aware pricing. Subscription providers
  (`claude_cli`, `ollama`) write $0 but still record tokens.
- **Sidebar widget** (`DailySpendBadge`) polls `GET /cost-cap/today`
  every 60s + on mutation.

## Project conventions

Rules for AI assistants (and humans) working in this repo. These
override default behavior — follow them exactly.

### LLM tunables live in `llm-tunables.config.ts`

All numeric tunables for LLM-calling code live in
`backend/src/config/llm-tunables.config.ts`. There are two kinds:

1. **Static per-agent settings** (`maxTokens`, `defaultModel`, hint
   output cap, build-context limits) on `AGENTS_CONFIG`. Read once
   at module load. Env-overridable via the `num()` / `str()`
   helpers.

2. **Context-window-derived values** (input-token warn threshold,
   plan.md truncation cap) accessed via the helper functions
   `inputTokenWarnThresholdFor(model)` and `planMdCapFor(model)`.
   These take the model in use at call time and derive the value
   from `MODEL_CONTEXT_WINDOWS` (75% of context for warn, 5% for
   plan.md cap). Env override wins if set.

**Never** declare a top-level `const FOO = <number>` in an agent or
service file for a tunable. Either:
- add an entry to `AGENTS_CONFIG` (static, per-agent), or
- compute via `inputTokenWarnThresholdFor` / `planMdCapFor` (per
  model, per call).

**Adding a new model:** when Anthropic ships a new model, add one
row to `MODEL_CONTEXT_WINDOWS` in `llm-tunables.config.ts`. The
unknown-model error message will point you to that exact line. The
table is keyed by base model ID — date-stamped IDs are normalized.

**Why:** ops needs to tune without redeploying. The eval harness
needs to sweep. Switching an agent to Haiku should auto-tighten the
plan.md cap from 50K to 10K without an env edit. Hardcoded constants
defeat all of this.

### Module dependency graph stays a DAG

No `forwardRef` in `backend/src/modules/`. If two modules look like
they need a cycle, the fix is one of: (1) extract a leaf module that
holds the shared types/data and both depend on it (see
`session-read/`, `build-sessions-data/`), or (2) replace one
direction with an event via `@nestjs/event-emitter` (see
`common/events/evaluation-events.ts`). Adding a `forwardRef` to "make
it compile" is not a fix — it's a deferred bug. Trace the cycle and
break it at the right layer.

### User-supplied strings going into LLM prompts go through `GuardrailsService`

The three routes that ingest free-form text into an LLM
(`POST /sessions/:id/snapshots`, `POST /sessions/:id/hints`,
`POST /questions`) call `GuardrailsService.guard(input, preset)`
before persisting or wrapping. Add a new preset to
`GUARDRAIL_PRESETS` rather than re-implementing trim / size /
closing-tag-escape logic in a new route.

### Database schema is canonical in `backend/prisma/schema.prisma`

Any question about the shape of data stored in the DB — what columns
exist, what's nullable, what indexes are on a table, what the FK
relationships are — read `backend/prisma/schema.prisma` directly.
Don't infer the schema from grepping Prisma queries, model usage, or
old commit messages; those drift. `backend/prisma/SCHEMA.md` is a
human-readable summary regenerated from the same source, useful when
you want a quick overview, but the `.prisma` file is the source of
truth.

### Two-call plan eval — when adding a new field

Adding a field to the eval output? Decide which call owns it:

- **Verdict-only data** (something the score depends on) → Call A's
  schema (`plan-results-tool-schema.ts`). Keep the output tiny — Call A's
  whole purpose is fast TTFS.
- **Narrative / evidence / explanatory data** → Call B's schema
  (`plan-details-tool-schema.ts`) + patched via `EvaluationsRepository.patchDetails`
  + rendered in `PlanEvaluationView` (frontend) gated on Call B
  completion (skeleton until then).

Shared schema atoms (`RESULT_ENUM`, `GAP_TOPIC_SUB_SCHEMA`) live in
`_shared-schema-atoms.ts` — both tools import from there so they can't
drift. The harness-only `monolithic` callKind in `plan-prompt.ts`
exists for `--compare-monolithic` regression checks; production code
paths only emit `results` or `details`.

### No commits unless explicitly asked

Do all the work — refactors, fixes, tests — but stop short of
`git add` / `git commit` until the user says so. Show the diff and
ask. This catches "I meant to review that first" before it becomes a
revert.

### Style

- No emojis unless explicitly requested.
- Default to no comments. Add one only when the WHY is non-obvious
  (a hidden constraint, a subtle invariant, a workaround for a known
  bug). Never describe WHAT the code does — the names already say
  that.
- Match existing commit-message style: lowercase scoped prefix
  (`backend/llm:`, `frontend:`, `backend/guardrails:`,
  `backend/eval-harness:`), focus on the why, 1-2 sentence body.

## Where to look for X

| Question | Path |
|---|---|
| What does each backend module do? | `agents/data/codebase-map/backend.md` |
| Live architecture diagrams | `agents/HUB.html` (single-page hub) |
| Database schema (canonical) | `backend/prisma/schema.prisma` |
| Human-readable schema summary + ER diagram | `backend/prisma/SCHEMA.md` or `agents/data/schema/SCHEMA_DIAGRAM.html` |
| All backend endpoints + call-flow | `agents/data/knowledge-graphs/backend-api-flow/API_EXPLORER.html` |
| Why was X decided that way? | `decisions.md` |
| Deferred structural work | `architectural-followups.md` |
| Local gaps + tech debt | `gaps.md` (gitignored — local working notes) |
| LLM tunables (per-agent + per-model) | `backend/src/config/llm-tunables.config.ts` |
| Rubric YAMLs (per variant) | `backend/rubrics/v3.0/plan.{traditional,agentic}_design.yaml`, `plan.agentic_build.yaml` (v3.0 is the default) |
| Eval-harness usage + fixture format | `backend/eval-harness/README.md` |
