import { Rubric } from '../types/rubric.types';
import { SystemBlock } from '../../llm/types/llm.types';
import { PhaseEvalInput } from '../types/evaluation.types';
import { dedupePlanMd } from '../helpers/dedupe-plan-md';

export interface BuiltPrompt {
  systemBlocks: SystemBlock[];
  userMessage: string;
  preprocessing: { removedParagraphs: number; removedChars: number };
}

export interface BuildPlanPromptOptions {
  useTools?: boolean;
}

export function buildPlanPrompt(
  rubric: Rubric,
  input: PhaseEvalInput,
  opts: BuildPlanPromptOptions = {},
): BuiltPrompt {
  // Both blocks are cacheable: the rubric is frozen across evaluations
  // and the session question is constant within a session, so prompt
  // caching catches them.
  const deduped = dedupePlanMd(input.planMd);
  const inputForRender: PhaseEvalInput =
    deduped.removedParagraphs > 0 ? { ...input, planMd: deduped.text } : input;

  return {
    systemBlocks: [
      { text: renderRubricSystemPrompt(rubric, opts.useTools === true), cacheable: true },
      { text: `## Session question\n${input.session.prompt}`, cacheable: true },
    ],
    userMessage: renderUserPayload(inputForRender),
    preprocessing: {
      removedParagraphs: deduped.removedParagraphs,
      removedChars: deduped.removedChars,
    },
  };
}

function renderRubricSystemPrompt(rubric: Rubric, useTools: boolean): string {
  const goodSignals = rubric.signals.filter((s) => s.polarity === 'good');
  const badSignals = rubric.signals.filter((s) => s.polarity === 'bad');

  const sectionsBlock = rubric.passBar.requiredSections
    .map((s) => `  - ${s.id} ("${s.name}") — must contain: ${s.mustContain.join(', ')}`)
    .join('\n');

  const goodSignalsBlock = goodSignals.map(formatSignal).join('\n\n');
  const badSignalsBlock = badSignals.map(formatSignal).join('\n\n');

  const pairs = goodSignals
    .filter((s) => s.pairedWith)
    .map((s) => `  - ${s.id} (good) ↔ ${s.pairedWith} (bad)`);
  const pairingBlock = pairs.length
    ? `## Pairing reference (do not double-count)
The following good↔bad signal pairs measure the same concept from
opposite sides. If the bad signal fires (HIT or PARTIAL), set its
paired good signal to MISS *only for reporting* — do NOT subtract its
weight separately. Count the deduction once, on whichever side
reflects the design's actual state.

${pairs.join('\n')}`
    : '';

  const anchorsBlock = Object.entries(rubric.scoring.anchors)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([score, desc]) => `  ${score}: ${desc}`)
    .join('\n');

  const calibrationBlock = rubric.judgeCalibration.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const aiUsage = rubric.aiUsageForThisPhase;
  const aiUsageBlock = aiUsage
    ? `## AI usage policy for this phase
${aiUsage.description}
Good modes: ${aiUsage.goodModes.join('; ')}
Bad modes: ${aiUsage.badModes.join('; ')}`
    : '';

  // v2.0+ has its variant pre-selected; v1.0 needs the LLM to classify.
  const modeOpener = rubric.mode
    ? `## How to read this rubric (the ${rubric.mode} variant has already been chosen)
You are evaluating a system-design plan in the **${rubric.mode}** variant
of the v2.0 plan rubric:
  - **build**  = small/buildable problem; candidate could realistically
                 implement and verify in the same session.
  - **design** = production-scale design exercise; candidate articulates,
                 does not implement.
The signals, weights, and anchors below already reflect ${rubric.mode}-mode
expectations — score against them directly. Do not classify the question
yourself; the routing was done at session creation time. Open the
\`feedback\` field with one line confirming the variant
(e.g. "${rubric.mode}: <one-sentence rationale tied to the question's scope>").`
    : `## How to read this rubric (IMPORTANT — read before judging)

This is a 1-hour session. Before scoring any signal, classify the question
into one of two modes — your judgment depth depends on which:

### Mode A — "buildable" (small, concrete problem, no large-scale NFRs)
The question asks for something the candidate could realistically design
AND build a working version of in ~1 hour.
Expectations: build_sequence_planned and validation_plan_concrete should
be concrete; failure_modes_articulated should name exercisable failures;
a short-but-complete plan can score HIT across most signals.

### Mode B — "design-only" (large-scale, distributed, infeasible to build in 1h)
The question stipulates production-grade NFRs or a distributed system.
Expectations: score articulation and reasoning, NOT execution evidence.
Every signal description starts with "Plan articulates ..." — interpret
literally. Question NFRs describe the TARGET system, not the validation
bar. A 4–6 step build sequence is plenty; full DDL is not required.

### How to use these modes
State your mode classification at the top of \`feedback\`. If genuinely
ambiguous, default to Mode B and note the ambiguity.`;

  const seniorityOpener = rubric.seniority
    ? `## Calibrate to the candidate's seniority: ${rubric.seniority}
You are evaluating a ${rubric.seniority}-level engineer. Apply these
expectations when judging individual signals (HIT / PARTIAL / MISS):
  - junior: clarity of intent + a working approach are enough. Accept
    rough articulation as PARTIAL rather than MISS. Don't penalize a
    light treatment of capacity, bottlenecks, or consistency.
  - mid:    add specificity — named interfaces, concrete validation,
    explicit tradeoffs. Capacity / bottleneck reasoning is a bonus.
  - senior: full bar — capacity, bottlenecks, scale-aware data model.
    The current rubric anchors are calibrated here.
  - staff:  bar is reasoning depth, not just coverage. Tradeoffs must
    be defended; bottlenecks named with concrete mitigations; a plan
    that hits all signals at HIT but lacks senior-level reasoning
    earns PARTIAL on those signals, not HIT.
Open the \`feedback\` field by acknowledging the seniority, e.g.
"${rubric.seniority}-level evaluation: …".`
    : '';

  return `You are an evaluator for the ${rubric.phaseName} phase of a system-design practice session.

Read the artifacts the user will provide and return a structured JSON evaluation matching the schema at the bottom of this prompt. Be specific and cite evidence from the artifacts. Do not invent content that isn't in the artifacts.

${modeOpener}

${seniorityOpener}

### Feedback prose must align with the mode (IMPORTANT)
The \`feedback\` and \`top_actions\` fields MUST be self-consistent with
your mode classification. They are read by the candidate after the
breakdown and they should not contradict it. Specifically:

- In **Mode B**, do NOT criticize the plan for "no build sequence",
  "no validation plan", "missing load tests", "no benchmarks", or
  similar — those expectations don't apply to a 1-hour design exercise
  on a production-scale problem. If the plan articulates the concept
  even briefly, that's enough; if it doesn't, treat it as out-of-scope
  rather than a gap.
- In **Mode B**, do NOT criticize the plan for "no AI strategy" /
  "missing AI usage section" UNLESS the question itself invokes AI,
  LLMs, or agentic systems. For non-AI questions (URL shortener, log
  pipeline, rate limiter, etc.), AI signals are not applicable —
  silently omit them from feedback.
- In **Mode A**, the above critiques ARE fair game when the plan
  genuinely lacks them, since the candidate could realistically build
  and test the system in 1 hour.
- \`top_actions\` should only include actions that are achievable and
  worthwhile within the same 1-hour design session. "Run a 10K req/s
  load test" is NOT a valid action; "sketch how you'd validate at demo
  scale" is. "Implement retry logic" is NOT valid; "name two failure
  modes you'd handle vs punt" is.

## Phase goal
${rubric.goal}

## Time bounds
Target ${rubric.timeBounds.targetMinMinutes}–${rubric.timeBounds.targetMaxMinutes} minutes. Flag if active work was under ${rubric.timeBounds.flagUnderMinutes} or over ${rubric.timeBounds.flagOverMinutes} minutes.${rubric.timeBounds.note ? `\nNote: ${rubric.timeBounds.note}` : ''}

## Pass bar
Required artifact: ${rubric.passBar.requiredArtifact}
${rubric.passBar.description}
Temporal check: ${rubric.passBar.temporalCheck}
Required sections in the artifact:
${sectionsBlock}

## How to find evidence (READ THIS BEFORE JUDGING SIGNALS)
The "required sections" above are organizational hints, NOT a literal
checklist. The candidate's plan.md is freeform Markdown — they may use
different headers, fold multiple concepts into one section, place a
concept in a paragraph that has no header at all, or put a Mermaid
diagram in lieu of prose. **For every signal, search the entire
plan.md (and the activity logs / hint history when relevant) for the
concept before deciding HIT / PARTIAL / MISS.** Do NOT downgrade a
signal just because the concept doesn't appear under the expected
header — judge by presence and clarity of the *idea*, anywhere in
the artifact.

Concrete examples of what counts as the concept being present:
- \`scope_cuts\` / \`scope_realism\`: any statement of what's in vs out,
  even buried inside an "Overview" or "Approach" paragraph.
- \`shape_and_seams\`: a Mermaid block that names components and the
  edges between them counts; so does a prose paragraph naming the
  same boundaries.
- \`capacity_estimation\`: any back-of-envelope number — QPS, storage,
  bandwidth — even if it's one line in a different section.
- \`data_model_committed\`: a sketch of entities/columns counts, even
  if the candidate didn't write a "Data model" header.
- \`caching_strategy_articulated\`: naming a cache layer in a
  diagram + saying when it's invalidated/bypassed counts.
- \`failure_modes_articulated\`: any concrete failure named (timeouts,
  partial outage, cache miss storms) with a posture toward it.

If you can't find the concept anywhere after searching the whole
artifact, MISS is correct. But "I expected it under section X and
didn't find it there" is NOT a reason to MISS or PARTIAL — extend the
search to the rest of the document first.

## Weight values (use these when scoring)
high = ${rubric.weightValues.high}, medium = ${rubric.weightValues.medium}, low = ${rubric.weightValues.low}

## GOOD signals (presence is positive)
${goodSignalsBlock}

## BAD signals (presence is negative; signals marked CRITICAL cap the final score)
${badSignalsBlock}

${pairingBlock}

## Scoring computation
${rubric.scoring.computation}
Scale: ${rubric.scoring.scaleMin}–${rubric.scoring.scaleMax}. Anchors:
${anchorsBlock}${rubric.scoring.calibrationNote ? `\nNote: ${rubric.scoring.calibrationNote}` : ''}

## Calibration notes
${calibrationBlock}

${aiUsageBlock}

## Mermaid diagrams in plan.md
The candidate's plan.md may include Mermaid diagrams in fenced
\`\`\`mermaid code blocks. Treat the diagram source as part of their
architectural articulation: read nodes as components, edges as data
or control flow, and judge it the same as prose. A clear diagram
counts toward signals like \`shape_and_seams\`, \`component_boundaries\`,
\`interfaces_sketched\`, and \`data_model_committed\` — quote a node or
edge by name in evidence when a diagram is what supports the signal.

## Relevance gating (IMPORTANT — read before judging)
Some signals only apply to questions in a specific domain. If a signal is
domain-specific and the SESSION QUESTION does not invoke that domain, mark
the signal "cannot_evaluate" with evidence "not applicable to this question
(<one-sentence reason>)". Do NOT score it as "miss" — a missed signal
implies the candidate had the chance to address it and didn't, which
unfairly penalizes designs for an unrelated topic.

### Hard rule: \`applies_to\`
Each signal that has an \`applies_to: [...]\` tag (visible in the signal
header above) is domain-restricted. Mark it "cannot_evaluate" UNLESS the
SESSION QUESTION clearly belongs to one of the listed domains.

- \`applies_to: agentic\` covers signals about agent infrastructure
  (inference cost, agent latency, output validation, provider failover,
  nondeterminism, agent observability, agent state). Mark these
  "cannot_evaluate" for traditional system-design questions (URL
  shortener, rate limiter, log pipeline, chat without LLM, ride-share
  matching, payments ledger, news feed, etc.). Score them only when
  the question explicitly involves LLM-driven agents, multi-agent
  orchestration, or LLM tool-use as the core of the design.

When a signal has no \`applies_to\` tag, it's universal — judge it
normally.

When in doubt about a non-tagged signal, prefer "miss" over
"cannot_evaluate" — only skip when the question genuinely has no
surface area for the signal.

Aggregate scoring: skipped ("cannot_evaluate") signals are excluded
from both earned and max totals so they do not change the score.

${renderOutputBlock(rubric, useTools)}`;
}

function renderOutputBlock(rubric: Rubric, useTools: boolean): string {
  if (useTools) {
    return `## Output
Submit your evaluation by calling the \`submit_evaluation\` tool. Every signal listed above (both good and bad) must appear in the \`signals\` object — the tool schema enforces this and unknown signal ids are rejected.

For each signal, write \`reasoning\` first (your brief justification), then commit to \`result\` (one of "hit", "partial", "miss", "cannot_evaluate"), then quote \`evidence\` verbatim from plan.md or activity logs (≤500 chars). For "cannot_evaluate", evidence must explain why the signal is not applicable to this question.

\`feedback\` (≤3000 chars) is a SYNTHESIS — open with the mode classification (e.g., "Mode B (design-only): question stipulates 10K req/s and 200M URLs."), then explain the score in 2–4 themes (what the plan got right, what it missed, what the candidate should learn). Do NOT enumerate per-signal pass/fail in feedback — that's what \`signals[*].evidence\` is for.

\`top_actions\` (≤5 items, each ≤200 chars) must be achievable in the same 1-hour design session. "Run a 10K req/s load test" is NOT valid; "sketch how you'd validate at demo scale" is.

\`gap_topics\` (≤5 items): system-design topics directly relevant to THIS question that the candidate either MISSED entirely or only LIGHTLY TOUCHED in plan.md. \`name\` must come from the schema's enum — paraphrasing is rejected. Pick a topic only when you can defend why it matters for this specific question (cite the question's NFR, scale, or domain in \`why_expected\`). Empty array is correct when nothing relevant is missing — do NOT pad. Examples: a URL shortener at 10K RPS without any caching mention -> \`{name: "cache_aside", coverage: "missed", why_expected: "10K RPS read-heavy with immutable slug->target mapping makes a cache the natural read path; plan.md does not mention any cache layer"}\`. A counter API where the candidate names locking but not the isolation level -> \`{name: "transaction_isolation", coverage: "lightly_touched", why_expected: "plan.md says 'use a lock' but doesn't pick READ_COMMITTED vs SERIALIZABLE — the choice changes both correctness and contention"}\`.`;
  }
  return `## OUTPUT FORMAT (strict)
Return ONLY a single valid JSON object. No prose. No markdown fences. No explanations outside the JSON.
Every signal listed above (both good and bad) must appear as a key in the "signals" object with one of: "hit", "miss", "partial", "cannot_evaluate".
"evidence" should quote or paraphrase the specific text from plan.md or activity logs that justifies your judgment (≤500 chars). For "cannot_evaluate", evidence must explain why the signal is not applicable to this question.

\`feedback\` (≤3000 chars) is a SYNTHESIS — open with the mode classification (e.g., "Mode B (design-only): question stipulates 10K req/s and 200M URLs."), then explain the score in 2–4 themes (what the plan got right, what it missed, what the candidate should learn). Do NOT enumerate per-signal pass/fail in feedback — that's what \`signals[*].evidence\` is for.

\`top_actions\` (≤5 items, each ≤200 chars) must be achievable in the same 1-hour design session. "Run a 10K req/s load test" is NOT valid; "sketch how you'd validate at demo scale" is.

\`gap_topics\` (≤5 items, each {name, coverage, why_expected}) lists system-design topics directly relevant to THIS question that the candidate missed or only lightly touched. \`name\` must come from the canonical vocabulary in the rubric outputSchema; \`coverage\` is "missed" or "lightly_touched"; \`why_expected\` cites what about THIS question makes the topic expected. Empty array is fine.

The JSON MUST match this schema:
${JSON.stringify(rubric.outputSchema, null, 2)}`;
}

function formatSignal(s: {
  id: string;
  weight: string;
  description: string;
  judgeNotes: string;
  evidenceHint?: string;
  critical?: boolean;
  capAtScore?: number;
  appliesTo?: string[];
}): string {
  const tags = [`weight: ${s.weight}`];
  if (s.critical) tags.push('CRITICAL');
  if (s.capAtScore !== undefined) tags.push(`caps score at ${s.capAtScore}`);
  if (s.appliesTo && s.appliesTo.length > 0) {
    tags.push(`applies_to: ${s.appliesTo.join(', ')}`);
  }
  return `### ${s.id} (${tags.join(', ')})
description: ${s.description}
judge_notes: ${s.judgeNotes}${s.evidenceHint ? `\nevidence_hint: ${s.evidenceHint}` : ''}`;
}

function renderUserPayload(input: PhaseEvalInput): string {
  const sections: string[] = [];

  sections.push(
    `## plan.md (final state)\n${input.planMd && input.planMd.trim().length > 0 ? input.planMd : '(empty)'}`,
  );

  if (input.snapshots.length === 0) {
    sections.push(`## Snapshot timeline\n(no snapshots — plan.md was never saved)`);
  } else {
    const sorted = [...input.snapshots].sort(
      (a, b) => a.takenAt.getTime() - b.takenAt.getTime(),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const sizes = sorted.map((s) => s.planMdSize);
    const grew = sizes[sizes.length - 1] > sizes[0];
    const lines = [
      `${sorted.length} snapshot(s) recorded`,
      `First save: ${first.takenAt.toISOString()} — plan.md was ${first.planMdSize} chars (active elapsed: ${first.elapsedMinutes}m)`,
      `Last save:  ${last.takenAt.toISOString()} — plan.md was ${last.planMdSize} chars (active elapsed: ${last.elapsedMinutes}m)`,
      `Trend: plan.md ${grew ? 'grew' : sizes[sizes.length - 1] === sizes[0] ? 'stable' : 'shrank'} across the session.`,
    ];
    sections.push(`## Snapshot timeline\n${lines.join('\n')}`);
  }

  // Full chat history is needed to judge ai_authored_plan reliably; no sampling.
  if (input.hints.length === 0) {
    sections.push(`## AI hint usage\nNo hint chat used during this session.`);
  } else {
    const lines = [`${input.hints.length} hint exchange(s) during the session.`];
    for (const h of input.hints) {
      lines.push(
        `- [${h.elapsedMinutes}m elapsed] User: ${JSON.stringify(h.prompt)}\n  Bot: ${JSON.stringify(h.response)}`,
      );
    }
    sections.push(`## AI hint usage\n${lines.join('\n')}`);
  }

  const activeMinutes =
    input.snapshots.length > 0
      ? Math.max(...input.snapshots.map((s) => s.elapsedMinutes))
      : 0;
  sections.push(
    `## Active elapsed\n${activeMinutes} minute(s) of active work (pause-aware, excludes paused time).`,
  );

  return sections.join('\n\n');
}
