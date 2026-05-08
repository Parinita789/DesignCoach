# Eval harness (plan + build phases)

A standalone runner that exercises `PlanAgent.evaluate()` and
`BuildAgent.evaluate()` against fixed fixtures with expected score ranges
and per-signal expectations. Use it to:

- catch regressions when editing `plan-prompt.ts` / `build-prompt.ts` or
  the rubric YAMLs under `rubrics/v*/`
- compare LLM providers (Anthropic / Ollama / Claude CLI) against the same fixtures
- collect calibration evidence when adjusting weights or anchors

This is **not** a unit test. It hits a real LLM. Provider selection follows
`backend/.env` (`LLM_PROVIDER`, `OLLAMA_BASE_URL`, etc.) — same dispatch as
production code via `LlmProviderFactory`.

Each fixture's own `phase:` field selects the agent (`plan` or `build`).
Use `--phase=plan|build` to restrict a run to one phase.

## Run it

From `backend/`:

```bash
# Plan-phase fixtures only (the default historic suite)
npm run eval:plan

# Build-phase fixtures only
npm run eval:build

# Every fixture in the suite, regardless of phase
npm run eval:all

# A subset by directory-name substring
npm run eval:plan  -- --filter=url-shortener
npm run eval:build -- --filter=incremental

# Write JSON report (in addition to console output)
npm run eval:build -- --out=./eval-out.json

# Override provider for a single run
LLM_PROVIDER=claude_cli   npm run eval:build
OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=llama3.1 npm run eval:plan
```

Exit code: `0` if every (non-`warnOnly`) fixture passed, `1` otherwise.

## Output shape

Console table per fixture, then a summary line. Failed fixtures print their
mismatch reasons inline:

```
Fixture                              | Score  | Expected    | Signals  | Time    | Verdict
url-shortener-thorough               | 4.25   | 3.5–5.0     | 5/5      | 6.2s    | PASS
url-shortener-empty                  | 1.00   | 0.0–2.0     | 3/3      | 5.8s    | PASS
rate-limiter-mid                     | 2.80   | 2.5–3.5     | 3/4      | 6.1s    | FAIL
   ✗ validation_plan_concrete expected miss, got partial ("…")
…
4/5 fixtures passed in 30.4s on provider=claude_cli model=claude-cli rubric=v1.0
```

The `--out` JSON contains everything in the console plus the full per-signal
evidence quotes — useful for diffing across runs.

## Fixture format

### Plan-phase fixture

```
fixtures/<name>/
  plan.md         # the plan being judged (the input artifact)
  fixture.yaml    # metadata + expectations
```

### Build-phase fixture

```
fixtures/<name>/
  plan.md          # the contract the build is judged against
  fixture.yaml     # metadata + expectations (with `phase: build`)
  events.jsonl     # one captured file event per line (required)
  ai-turns.jsonl   # optional Claude Code conversation turns
```

`events.jsonl` lines match the CLI's wire format:

```json
{"filePath":"repos/url_repo.py","action":"created","content":"...","contentDiff":null,"occurredAt":"2026-05-08T10:00:00Z"}
{"filePath":"repos/url_repo.py","action":"modified","content":null,"contentDiff":"--- a/...\n+++ b/...\n@@ ...","occurredAt":"2026-05-08T10:05:40Z"}
```

The harness reconstructs the final tree the same way the orchestrator does
(`reconstructBuildTree`), then trims to the prompt-shaped slice
(`selectBuildContext`).

`ai-turns.jsonl` lines mirror the `BuildAIInteraction` row shape: `externalSessionId`,
`turnIndex`, `role`, `text` (nullable), `toolName` / `toolInputSummary` /
`toolResultSummary` (nullable), `occurredAt`.

### `fixture.yaml` schema (shared)

```yaml
description: "One-line summary that lands in the console output."
question: "Design a URL shortener for 10K req/s and 200M URLs."
rubricVersion: v2.0
phase: plan    # plan (default) or build. Selects which agent runs and
               # which rubric the loader validates expectedSignals against.
mode: design   # required for v2.0+; one of: build, design.
               # For v1.0, omit this field — the legacy single-rubric
               # path is used.

# Build-phase only: the captured build window. Used by BuildContext
# so the agent sees a realistic startedAt/endedAt.
buildStartedAt: "2026-05-08T09:59:30Z"
buildEndedAt:   "2026-05-08T10:07:00Z"

# LLM judgments are noisy. Score is a tolerated range, not an exact value.
expectedScore:
  min: 3.5
  max: 5.0

# Per-signal expectations. Modes:
#   hit         judge must return HIT
#   partial     judge must return PARTIAL
#   miss        judge must return MISS
#   credited    HIT or PARTIAL accepted (lenient "earned credit")
#   skipped     cannot_evaluate (use for relevance-gated signals)
expectedSignals:
  credited: [scope_specificity, dual_scale_nfrs]
  miss: []
  hit: []
  skipped: [ai_strategy_explicit]      # e.g., non-AI question

# Optional: emit the mismatches but don't fail the suite. Useful while
# calibrating a new fixture. Default false.
warnOnly: false

# Optional: synthetic hint chat history if the fixture wants to test the
# AI-authored-plan signal. Each entry shows up in the user payload.
hints:
  - occurredAt: "2026-04-30T12:00:00Z"
    elapsedMinutes: 5
    prompt: "What's the read/write ratio?"
    response: "What does your scope say about peak RPS?"
```

Signal IDs in `expectedSignals.*` are **validated against the rubric at
startup** — a typo throws before any LLM call, instead of silently passing
because "the signal was never returned, so we never noticed."

## Adding a new fixture

1. Create `fixtures/<name>/` with `plan.md` (the artifact) and an empty
   `fixture.yaml` containing only `description`, `question`, `rubricVersion`,
   and a placeholder `expectedScore: { min: 0, max: 5 }`.
2. Run `npm run eval:plan -- --filter=<name>` — it will pass trivially
   because the score range is wide and there are no signal expectations.
   Read the actual score and per-signal output.
3. Tighten `expectedScore` to a range around the observed score (give it
   ~±0.5 leeway for LLM noise).
4. Decide which signals you want to lock in; add them to `expectedSignals`.
   Use `credited` over `hit` unless you specifically want a strict full-hit.
5. Re-run; iterate until the fixture passes consistently across 2–3 runs.
6. Commit.

## Seed fixtures

### Plan phase

| Fixture | Question | Expected verdict |
| --- | --- | --- |
| `url-shortener-thorough` | URL shortener at 10K req/s | Good (3.5–5.0) |
| `url-shortener-handwaved` | URL shortener at 10K req/s | Average (~2.5–3.5) |
| `url-shortener-empty` | URL shortener at 10K req/s | Failed (0.0–2.0) |
| `rate-limiter-mid` | Token-bucket rate limiter | Average (2.5–3.5) |
| `chat-app-with-ai-coach` | Chat app with Socratic AI coach | Good (3.0–4.5), AI signals **not** skipped |
| `log-pipeline-no-ai` | 50K eps log ingestion pipeline | Average–Good (2.5–4.0), AI signals skipped |
| `agentic-code-review` | Agentic code review | Good, exercises agent-infra signals |

The AI-related fixtures are paired intentionally: one where AI signals
should fire, one where they should be skipped. Together they exercise the
relevance-gating rule in `plan-prompt.ts`.

### Build phase

| Fixture | Plan / build | Expected verdict |
| --- | --- | --- |
| `build-incremental-urlshort` | URL shortener (build mode) | Good (3.5–5.0). 8 events spread over ~7 min, tests + acknowledged-deviation, 10 AI turns showing steering. Hits `code_matches_plan`, `test_appropriateness`, `design_evolution_coherence`, `ai_used_as_collaborator`; misses the paired bad signals. |

## Out of scope (for now)

- `--calibrate` flag that writes a draft `fixture.yaml` from the LLM output.
- CI integration / drift dashboards / scheduled runs.
- Multi-provider comparison report (run twice, diff the JSON manually).
- Statistical analysis (running each fixture N times to compute variance).
- Harnesses for `validate`, `wrap` — those agents are still stubs.
