import { Rubric } from '../types/rubric.types';
import { SystemBlock } from '../../llm/types/llm.types';
import { PhaseEvalInput } from '../types/evaluation.types';

export interface BuiltBuildPrompt {
  systemBlocks: SystemBlock[];
  userMessage: string;
}

export interface BuildBuildPromptOptions {
  useTools?: boolean;
}

export function buildBuildPrompt(
  rubric: Rubric,
  input: PhaseEvalInput,
  opts: BuildBuildPromptOptions = {},
): BuiltBuildPrompt {
  return {
    systemBlocks: [
      { text: renderRubricSystemPrompt(rubric, opts.useTools === true), cacheable: true },
      { text: `## Session question\n${input.session.prompt}`, cacheable: true },
      { text: renderPlanCrossReference(input.planMd), cacheable: true },
    ],
    userMessage: renderUserPayload(input),
  };
}

function renderRubricSystemPrompt(rubric: Rubric, useTools: boolean): string {
  const goodSignals = rubric.signals.filter((s) => s.polarity === 'good');
  const badSignals = rubric.signals.filter((s) => s.polarity === 'bad');

  const goodSignalsBlock = goodSignals.map(formatSignal).join('\n\n');
  const badSignalsBlock = badSignals.map(formatSignal).join('\n\n');

  const pairs = goodSignals
    .filter((s) => s.pairedWith)
    .map((s) => `  - ${s.id} (good) <-> ${s.pairedWith} (bad)`);
  const pairingBlock = pairs.length
    ? `## Pairing reference (do not double-count)
The following good/bad signal pairs measure the same concept from
opposite sides. If the bad signal fires (HIT or PARTIAL), set its
paired good signal to MISS only for reporting; do NOT subtract its
weight separately. Count the deduction once, on whichever side
reflects the build's actual state.

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

  const modeOpener = rubric.mode
    ? `## How to read this rubric (the ${rubric.mode} variant has already been chosen)
You are evaluating the **build** phase of a system-design practice session in
the **${rubric.mode}** variant:
  - **build mode**  = small/buildable problem; the candidate was expected
                      to ship a working implementation. Test signals and
                      incremental-build signals are weighted high.
  - **design mode** = production-scale design exercise; build-phase artifacts
                      are typically small (sketches, prototype slices, more
                      plan elaboration). Test signals are deweighted; an
                      empty build phase is normal.
The signals, weights, and anchors below already reflect ${rubric.mode}-mode
expectations. Open the \`feedback\` field with one line confirming the
variant.`
    : `## How to read this rubric
This evaluator scores the build phase against the captured artifacts.`;

  const seniorityOpener = rubric.seniority
    ? `## Calibrate to the candidate's seniority: ${rubric.seniority}
You are evaluating a ${rubric.seniority}-level engineer.
  - junior: clarity of execution + a working slice are enough. Accept
    rough structure as PARTIAL rather than MISS.
  - mid:    consistent structure, basic tests, AI used as accelerator.
  - senior: structure mirrors the plan, tests cover the plan's seams,
    AI conversation shows steering and rejection.
  - staff:  bar is judgment under time pressure. The candidate should
    have made the right cuts, used AI surgically, and shown the
    reasoning behind departures from plan.
Open the \`feedback\` field by acknowledging the seniority.`
    : '';

  return `You are an evaluator for the ${rubric.phaseName} phase of a system-design practice session.

Read the captured artifacts the user will provide (file events, AI conversation turns, the reconstructed final tree, and the candidate's plan.md) and return a structured evaluation matching the schema at the bottom. Be specific and cite evidence verbatim from the artifacts. Do not invent content that isn't there.

${modeOpener}

${seniorityOpener}

## Phase goal
${rubric.goal}

## Time bounds
Target ${rubric.timeBounds.targetMinMinutes}-${rubric.timeBounds.targetMaxMinutes} minutes. Flag if active build was under ${rubric.timeBounds.flagUnderMinutes} or over ${rubric.timeBounds.flagOverMinutes} minutes.${rubric.timeBounds.note ? `\nNote: ${rubric.timeBounds.note}` : ''}

## Pass bar
Required artifact: ${rubric.passBar.requiredArtifact}
${rubric.passBar.description}
Temporal check: ${rubric.passBar.temporalCheck}

## How to find evidence (READ THIS BEFORE JUDGING SIGNALS)
The captured artifacts come from a CLI watcher and Claude Code conversation
logs. Some are exact (file contents, diffs, AI message text); some are
summaries (event counts per file, tree paths). For every signal:

- Look across ALL artifacts before deciding. A signal that's missing from
  one source may be present in another. For example, design_evolution_coherence
  may be visible in an AI turn even if no plan.md edit was captured.
- Quote VERBATIM in evidence: a path from the tree, a snippet from a file,
  a turn from the AI conversation, or a span from plan.md.
- Empty-build-phase handling: if no events were captured, prefer
  cannot_evaluate over miss for signals that need code (test_appropriateness,
  structure_soundness). silent_drift cannot be judged from absence of code
  alone, so set it cannot_evaluate too.

## Weight values (use these when scoring)
high = ${rubric.weightValues.high}, medium = ${rubric.weightValues.medium}, low = ${rubric.weightValues.low}

## GOOD signals (presence is positive)
${goodSignalsBlock}

## BAD signals (presence is negative; signals marked CRITICAL cap the final score)
${badSignalsBlock}

${pairingBlock}

## Scoring computation
${rubric.scoring.computation}
Scale: ${rubric.scoring.scaleMin}-${rubric.scoring.scaleMax}. Anchors:
${anchorsBlock}${rubric.scoring.calibrationNote ? `\nNote: ${rubric.scoring.calibrationNote}` : ''}

## Calibration notes
${calibrationBlock}

${aiUsageBlock}

${renderRelevanceGatingBlock(rubric)}
${renderOutputBlock(useTools)}`;
}

function renderRelevanceGatingBlock(rubric: Rubric): string {
  const hasGated = rubric.signals.some((s) => s.appliesTo && s.appliesTo.length > 0);
  if (!hasGated) return '';
  return `## Relevance gating
Some signals have an \`applies_to: [...]\` tag in the signal header above.
Mark those "cannot_evaluate" with a one-sentence reason if the session
question does not belong to one of the listed domains. Skipped signals
are excluded from both earned and max totals so they do not change the
score.
`;
}

function renderOutputBlock(useTools: boolean): string {
  if (useTools) {
    return `## Output
Submit your evaluation by calling the \`submit_build_evaluation\` tool. Every signal listed above (good and bad) must appear in the \`signals\` object — the tool schema enforces this and unknown signal ids are rejected.

For each signal, write \`reasoning\` first (a brief justification grounded in the captured artifacts), then commit to \`result\` (one of "hit", "partial", "miss", "cannot_evaluate"), then quote \`evidence\` verbatim from a captured artifact (<=500 chars). For "cannot_evaluate", evidence must explain why the signal is not applicable to this build.

\`feedback\` (<=3000 chars) is a SYNTHESIS — open with the variant confirmation, then explain the score in 2-4 themes (what the candidate executed well, what slipped, what to learn). Do NOT enumerate per-signal pass/fail in feedback — that's what \`signals[*].evidence\` is for.

\`top_actions\` (<=5 items, each <=200 chars) must be achievable in a similar future session.`;
  }
  return `## OUTPUT FORMAT (strict)
Return ONLY a single valid JSON object. No prose. No markdown fences. No explanations outside the JSON.
Every signal listed above (good and bad) must appear as a key in the "signals" object with one of: "hit", "miss", "partial", "cannot_evaluate".
"evidence" should quote verbatim from a captured artifact (<=500 chars).

\`feedback\` (<=3000 chars) is a SYNTHESIS, not a per-signal enumeration.

\`top_actions\` (<=5 items, each <=200 chars) must be achievable in a similar future session.`;
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

function renderPlanCrossReference(planMd: string | null): string {
  const body = planMd && planMd.trim().length > 0 ? planMd : '(no plan.md captured)';
  return `## plan.md (the contract this build is being judged against)\n${body}`;
}

function renderUserPayload(input: PhaseEvalInput): string {
  const sections: string[] = [];
  const ctx = input.buildContext;

  if (!ctx) {
    sections.push(
      '## Build phase summary\nNo build context was provided to the evaluator. ' +
        'Score every signal cannot_evaluate with this note as evidence.',
    );
    return sections.join('\n\n');
  }

  const startedAt = ctx.startedAt;
  const endedAt = ctx.endedAt;
  const durationMin =
    endedAt && startedAt
      ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000))
      : null;
  const eventCount = ctx.events.length;
  const aiTurnCount = ctx.aiTurns.length;
  const treeSize = ctx.finalTree.length;
  const aiSessions = new Set(ctx.aiTurns.map((t) => t.externalSessionId)).size;

  sections.push(
    `## Build phase summary
Started: ${startedAt ? startedAt.toISOString() : '(unknown)'}
Ended:   ${endedAt ? endedAt.toISOString() : '(still in progress / not finalised)'}
Duration: ${durationMin === null ? '(unknown)' : `${durationMin} minutes`}
Captured: ${eventCount} file event(s) across ${treeSize} surviving file(s); ${aiTurnCount} AI conversation turn(s) across ${aiSessions} Claude Code session(s).`,
  );

  if (treeSize === 0) {
    sections.push('## File tree (final state)\n(no files survived the build)');
  } else {
    const lines = ctx.finalTree.map(
      (f) => `${f.path} | ${f.size} bytes | ${f.sha1.slice(0, 12)}`,
    );
    sections.push(`## File tree (final state)\n${lines.join('\n')}`);
  }

  if (ctx.keyFileSnippets.length === 0) {
    sections.push('## Key file snippets\n(no high-churn files to highlight)');
  } else {
    const blocks = ctx.keyFileSnippets.map(
      (s) => `### ${s.path}\n\`\`\`\n${s.content}\n\`\`\``,
    );
    sections.push(`## Key file snippets (top high-churn files, capped per file)\n${blocks.join('\n\n')}`);
  }

  if (eventCount === 0) {
    sections.push('## Build event timeline\n(no events captured)');
  } else {
    const perFile = aggregatePerFile(ctx.events);
    const lines = perFile.map(
      (p) =>
        `${p.path} | ${p.eventCount} event(s) | ${p.firstAt.toISOString()} -> ${p.lastAt.toISOString()}`,
    );
    sections.push(`## Build event timeline (per-file aggregate, sorted by event count)\n${lines.join('\n')}`);
  }

  if (aiTurnCount === 0) {
    sections.push('## AI conversation turns\n(no Claude Code turns captured)');
  } else {
    const lines = ctx.aiTurns.map((t) => formatAiTurn(t));
    sections.push(`## AI conversation turns (chronological, capped)\n${lines.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

function aggregatePerFile(events: NonNullable<PhaseEvalInput['buildContext']>['events']) {
  const byPath = new Map<
    string,
    { path: string; eventCount: number; firstAt: Date; lastAt: Date }
  >();
  for (const e of events) {
    const cur = byPath.get(e.filePath);
    if (!cur) {
      byPath.set(e.filePath, {
        path: e.filePath,
        eventCount: 1,
        firstAt: e.occurredAt,
        lastAt: e.occurredAt,
      });
    } else {
      cur.eventCount += 1;
      if (e.occurredAt < cur.firstAt) cur.firstAt = e.occurredAt;
      if (e.occurredAt > cur.lastAt) cur.lastAt = e.occurredAt;
    }
  }
  return [...byPath.values()].sort((a, b) => b.eventCount - a.eventCount);
}

function formatAiTurn(
  t: NonNullable<PhaseEvalInput['buildContext']>['aiTurns'][number],
): string {
  const parts = [`[${t.occurredAt.toISOString()}] (${t.externalSessionId.slice(0, 8)} #${t.turnIndex}) ${t.role}`];
  if (t.text && t.text.trim().length > 0) parts.push(t.text);
  if (t.toolName) {
    const inp = t.toolInputSummary ? ` input=${t.toolInputSummary}` : '';
    const res = t.toolResultSummary ? ` result=${t.toolResultSummary}` : '';
    parts.push(`tool: ${t.toolName}${inp}${res}`);
  }
  return parts.join('\n');
}
