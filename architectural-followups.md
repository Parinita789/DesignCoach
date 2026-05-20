# Architectural Follow-ups

The 27-gap code review of the orchestrator / plan agent / build-session
plumbing produced 15 quick wins (commits prefixed `Gap N:` between
`8e3e6a9` and `dd1507c`) and 4 deferred work tracks that each warrant
their own session because they touch the system shape, not a single
file. This document captures the four tracks, in the order I would
sequence them.

The numeric "Gap N" references map back to the original review.

---

## Track 1 — Outbox for fire-and-forget LLM dispatch

**Source review items:** Gaps 1, 3, 15, 24

**What it is.** Every place we currently call
`tasks.track(this.someService.generate(...))` is a promise the orchestrator
fires and forgets. `BackgroundTaskTracker` keeps the process alive until
they settle (graceful shutdown wins) but the promise itself lives in
process memory: a SIGKILL, a crash, an unhandled rejection — any of
those — and the deep-dive mentor / signal-mentor / build-eval re-dispatch
silently drops on the floor. The orchestrator partly works around this
in `finishBuildPhase` (Gap 14) by detecting a missing build eval on
re-call and re-dispatching, but that's an ad-hoc retry layer per
hot-path; mentor and signal-mentor have no equivalent.

**The fix is an outbox table.** A new `event_outbox` row gets inserted
inside the same transaction as the row that triggers it
(`PhaseEvaluation.create` in this case). A worker tails the outbox,
locks rows with `SKIP LOCKED`, calls the same handler the orchestrator
calls today, marks the row complete (or `failed_at` after N attempts).
Crashes are recoverable because the outbox is durable; replays are
idempotent because the handler is keyed on the source row id.

**Why this is one of the most valuable things to ship next.** Right
now every "the orchestrator dispatched X but X never landed" debugging
session has to reason from logs alone. With the outbox, the row itself
records intent + completion, and the same plumbing also covers Gap 24
(retry-on-fail for transient mentor failures), Gap 15 (re-dispatch
mentor when the user opens the results page for a session whose mentor
never landed), and Gap 1 (the orchestrator's "dispatched two mentor
calls in parallel" can be rephrased as "wrote two outbox rows" — same
behavior, different durability story).

**Sequencing.** Build the outbox infrastructure first; then move
mentor.generate and signalMentor.generate behind it; then the build-eval
re-dispatch. Each step is a separate PR.

**Rough size.** ~3 days of focused work. New table, migration, worker
service (cron-tick or pg-listen), handler registry, idempotency token
on every emitted row.

---

## Track 2 — Replace bcrypt build tokens with signed JWTs

**Source review items:** Gap 18 (and the related Gaps 19, 21, 23 about
auth hardening)

**What it is.** Today: build-token mint hashes a 32-byte random secret
with bcrypt, stores the hash on the session row. Verify reads the row,
runs `bcrypt.compare`. Every event-batch flush from the CLI is a
bcrypt round-trip; with the cleanup work in Gap 20 we collapse some
of the cost on rejection paths, but the happy path still pays bcrypt
on every batch.

**The fix is a signed JWT (HS256) keyed on a server-side secret.** The
mint signs `{ sub: sessionId, iat, exp }` and returns the JWT as the
bearer token. The verify path decodes + verifies the signature
(microseconds, no DB round-trip for happy-path token shape checks),
then does a single DB query to confirm the session's status / endedAt.

**Why this matters beyond perf.** It also closes the side channels
the Gap 22 work narrowed but didn't eliminate. With JWT, "expired
token" is decided locally from the `exp` claim — no DB call at all
for an expired token, and no way for an attacker probing tokens to
distinguish "session doesn't exist" from "wrong secret" from "expired"
beyond what the timing of one signature-check operation reveals
(constant-time).

**Sequencing.** New BuildTokenService method `mintJwt(sessionId)` next
to existing `mintForSession` — keep both paths during the migration.
Switch verify to "try JWT first, fall back to bcrypt" for one
deployment cycle so old in-flight tokens still work; then drop the
bcrypt branch.

**Rough size.** ~1.5 days. New env (`BUILD_TOKEN_SIGNING_SECRET`),
update mint + verify, dual-stack the verify path, write tests for
both shapes, update the CLI README's expected token format.

---

## Track 3 — OpenTelemetry instrumentation

**Source review items:** Gaps 9 (full), 26

**What it is.** Gap 9 was partially closed — `Date.now()` → `performance.now()`
for monotonic latency measurements — but the half that was deferred
is the real value: spans across the orchestrator → agent → LLM provider
flow, with attributes like `model`, `tokens_in`, `tokens_out`, `phase`,
`session_id`. Today the only place latency lives is a single log line
per LLM call; you can't ask "p95 latency for build-phase Opus calls
last week" or "which prompt revisions doubled output tokens".

**The fix is OTel + auto-instrumentation for the LLM SDK.** Initialize
the OTel SDK in `main.ts`, wrap `LlmService.call` with a span, and add
attributes from the `LlmResponse` shape. Add the same for orchestrator
phases and the mentor/signal-mentor services so deep-dive flame graphs
work end-to-end.

**Why this matters now (vs whenever).** As we tune per-agent models
(Gap 12 made this configurable), measuring is the only way to confirm
"ah, BUILD_AGENT_MODEL=sonnet improved p95 latency by 60% with no
quality regression." Without spans, every model-switch decision is a
gut call.

**Sequencing.** Standalone — no dependencies on other tracks. Pick a
backend (Honeycomb, Tempo, Jaeger — any OTLP-compatible target) and
wire it. The semantic conventions for LLM calls are still evolving;
follow the Anthropic SDK's recommendations for the attribute
namespace (`gen_ai.*`).

**Rough size.** ~1 day for the wiring; ongoing cost is the backend
subscription + dashboard authoring.

---

## ~~Track 4 — Cost tracking + per-session / per-day budgets~~ — SHIPPED

**Source review items:** Gap 25
**Status:** Shipped via commits `86a3cb3` (ledger), `56b20fa` (service +
pricing), `cdfafaf` (LlmService wire-up), `8d4ac54` (frontend 403
handling), `fff00e7` (sidebar widget + `GET /cost-cap/today`).

**What landed vs the original draft.** The implementation took a
shape the draft didn't anticipate: a denormalized, user-keyed
`llm_spend` ledger (one row per LLM call, with `estimated_cost_usd`
computed at call time from `backend/src/modules/cost-cap/pricing.ts`)
rather than adding a `cost_usd` column to each existing audit table.
The rationale lives in `backend/prisma/SCHEMA.md` under "LlmSpend is
the cost-cap ledger, not an audit replacement" — short version:
single-table index seek on `(user_id, occurred_at)` for the hot cap
check, every LLM call captured in one place via the wrap inside
`LlmService.call`, and analytics ("which route, which model, what
period") fall out of the same shape for free.

**Tracking.** Live in `backend/src/modules/cost-cap/pricing.ts`
(`ANTHROPIC_PRICING` table) and `llm_spend` rows. Subscription
providers (`claude_cli`, `ollama`) record tokens but cost = $0.

**Budgets.** `LLM_DAILY_CAP_USD` env (default $5/user/day) drives
`CostCapService.assertWithinCap` before every LLM dispatch. Cap
exceeded → HTTP 403 with `code: COST_CAP_EXCEEDED` + `resetAtUtc`.
The frontend renders "Daily LLM budget reached: $X / $Y. Resets in
Nh Nm." via `describeError`, plus a sidebar progress widget showing
live spend.

**Still deferred from the draft.** Per-session budgets (the daft
contemplated `daily_cost_budgets` keyed on `scope = 'global' |
'session'`). The shipped scope is per-user only; session-level
budgets weren't built. Adding them is one WHERE-clause and a config
column. Per-tier user budgets (paying-tier override on the User
row) are also still v2.

---

## Track 5 — Saga / state machine for evaluation_run

**Source review items:** Gap 2, Gap 6

**What it is.** A "run" today is implicit: rows in `phase_evaluations`,
`evaluation_audits`, `mentor_artifacts`, and `signal_mentor_artifacts`
are loosely linked by `phaseEvaluationId`, but there's no row that
says "the user clicked Re-evaluate at T, here's the run id, here's
what was attempted, here's what landed, here's what's still pending."
When a mentor.generate fails silently (Track 1's premise), there's
no place a UI could read to show a retry affordance.

**The fix is an `evaluation_run` row with a status column.** The
controller's POST creates a `pending` run, the orchestrator marks
its phase evals as it produces them, the outbox-driven mentor work
flips sub-status to `mentor_pending` → `mentor_complete`, etc. The
results page polls the run row and renders a deterministic state.

**Why this is last on the list.** It's the most invasive of the five —
new table, new query patterns in the frontend, retry/resume UX. But
it's also the natural endpoint of Tracks 1 + 4: once the outbox
durably tracks "what was dispatched" and cost-tracking knows "what
was spent," the run row is the user-facing summary of both.

**Sequencing.** Strictly after Track 1; Tracks 2/3/4 can ship
independently.

**Rough size.** ~3–5 days. Schema, orchestrator state transitions,
frontend polling + state rendering, retry endpoint + UI.

---

## Suggested order

1. **Track 1 (outbox)** — most leverage; unblocks Track 5.
2. **Track 3 (OTel)** — cheap, immediate observability, no dependencies.
3. ~~**Track 4 (cost tracking)**~~ — SHIPPED. See Track 4 section.
4. **Track 2 (JWT auth)** — mostly a perf + side-channel cleanup; not urgent unless multi-tenant.
5. **Track 5 (run state machine)** — the longest pole; do it after the outbox makes the underlying state durable.

Each track is independently shippable; nothing here requires the
others to be complete to be useful. The order above optimizes for
"smallest thing that gives biggest visibility into how the system is
behaving" first.
