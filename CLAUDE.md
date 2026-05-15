# Project conventions

Rules for AI assistants (and humans) working in this repo. These
override default behavior — follow them exactly.

## LLM tunables live in `llm-tunables.config.ts`

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

## Module dependency graph stays a DAG

No `forwardRef` in `backend/src/modules/`. If two modules look like
they need a cycle, the fix is one of: (1) extract a leaf module that
holds the shared types/data and both depend on it (see
`session-read/`, `build-sessions-data/`), or (2) replace one
direction with an event via `@nestjs/event-emitter` (see
`common/events/evaluation-events.ts`). Adding a `forwardRef` to "make
it compile" is not a fix — it's a deferred bug. Trace the cycle and
break it at the right layer.

## User-supplied strings going into LLM prompts go through
`GuardrailsService`

The three routes that ingest free-form text into an LLM
(`POST /sessions/:id/snapshots`, `POST /sessions/:id/hints`,
`POST /questions`) call `GuardrailsService.guard(input, preset)`
before persisting or wrapping. Add a new preset to
`GUARDRAIL_PRESETS` rather than re-implementing trim / size /
closing-tag-escape logic in a new route.

## No commits unless explicitly asked

Do all the work — refactors, fixes, tests — but stop short of
`git add` / `git commit` until the user says so. Show the diff and
ask. This catches "I meant to review that first" before it becomes a
revert.

## Style

- No emojis unless explicitly requested.
- Default to no comments. Add one only when the WHY is non-obvious
  (a hidden constraint, a subtle invariant, a workaround for a known
  bug). Never describe WHAT the code does — the names already say
  that.
- Match existing commit-message style: lowercase scoped prefix
  (`backend/llm:`, `frontend:`, `backend/guardrails:`), focus on the
  why, 1-2 sentence body.
