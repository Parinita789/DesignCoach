// Shared schema validation for the evaluation output object.
// Both the JSON-text parser (parse-eval-output.ts) and the tool-args
// validator (validate-eval-tool-args.ts) used to maintain parallel
// copies of the signal/feedback/top_actions/gap_topics schema. They
// drifted in subtle ways (text parser dropped `reasoning`; tool-args
// hardcoded `score: 0`; the unknown-signal policy differed). This
// module is the single source of truth — the two file-level entry
// points keep their distinct I/O shape but funnel through here for
// every per-field check.

import { GapTopic, SignalResult } from '../types/evaluation.types';
import { isCanonicalTopic } from '../helpers/canonical-topics';

export class EvaluationParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'EvaluationParseError';
  }
}

export interface ParsedEvalOutput {
  score: number;
  signals: Record<string, SignalResult>;
  feedback: string;
  topActions: string[];
  gapTopics: GapTopic[];
  droppedSignalIds?: string[];
  droppedTopicNames?: string[];
}

const VALID_RESULTS = new Set(['hit', 'miss', 'partial', 'cannot_evaluate']);
const VALID_GAP_COVERAGES = new Set<GapTopic['coverage']>([
  'missed',
  'lightly_touched',
]);

export interface SharedValidationOptions {
  // Original raw text for error reporting (rendered LLM response or
  // pretty-printed tool args).
  rawText: string;
  // Signal ids the rubric declares. Used to gate unknown ids and to
  // verify completeness when rejectUnknownSignals is true.
  expectedSignalIds?: ReadonlySet<string>;
  // Tool-use path is strict: every signal id must be in the rubric.
  // Text path is lenient: hallucinated ids are dropped with a warning.
  rejectUnknownSignals: boolean;
  // Tool-use path also requires the LLM to fill in every expected
  // signal. Text path doesn't enforce this — the LLM may have skipped.
  requireAllExpectedSignals: boolean;
  // Tool-args path uses a deterministic computed score, so the LLM's
  // claimed score is irrelevant; text path needs it for disagreement
  // detection. Default reads `obj.score`.
  scoreOverride?: number;
}

export function validateEvalObject(
  obj: Record<string, unknown>,
  opts: SharedValidationOptions,
): ParsedEvalOutput {
  const { rawText, expectedSignalIds, rejectUnknownSignals, requireAllExpectedSignals } = opts;

  if (!obj.signals || typeof obj.signals !== 'object' || Array.isArray(obj.signals)) {
    throw new EvaluationParseError('Missing or invalid "signals" object', rawText);
  }

  const signals: Record<string, SignalResult> = {};
  const droppedSignalIds: string[] = [];
  for (const [signalId, val] of Object.entries(obj.signals as Record<string, unknown>)) {
    if (expectedSignalIds && !expectedSignalIds.has(signalId)) {
      if (rejectUnknownSignals) {
        throw new EvaluationParseError(
          `Unknown signal id "${signalId}" not in rubric`,
          rawText,
        );
      }
      droppedSignalIds.push(signalId);
      continue;
    }
    signals[signalId] = validateSignalEntry(signalId, val, rawText);
  }

  if (requireAllExpectedSignals && expectedSignalIds) {
    for (const id of expectedSignalIds) {
      if (!(id in signals)) {
        throw new EvaluationParseError(`Missing signal "${id}" in tool args`, rawText);
      }
    }
  }

  if (typeof obj.feedback !== 'string') {
    throw new EvaluationParseError('Missing or non-string "feedback"', rawText);
  }

  const topActionsRaw = (obj.top_actions ?? obj.topActions) as unknown;
  if (!Array.isArray(topActionsRaw)) {
    throw new EvaluationParseError('Missing or non-array "top_actions"', rawText);
  }
  const topActions: string[] = [];
  for (const item of topActionsRaw) {
    if (typeof item !== 'string') {
      throw new EvaluationParseError('"top_actions" must contain only strings', rawText);
    }
    topActions.push(item);
  }

  const gap = extractGapTopics(obj, rawText);

  let score: number;
  if (opts.scoreOverride !== undefined) {
    score = opts.scoreOverride;
  } else {
    const scoreCandidate = obj.score;
    score =
      typeof scoreCandidate === 'number' && !Number.isNaN(scoreCandidate)
        ? scoreCandidate
        : 0;
  }

  return {
    score,
    signals,
    feedback: obj.feedback,
    topActions,
    gapTopics: gap.topics,
    droppedSignalIds: rejectUnknownSignals ? undefined : droppedSignalIds,
    droppedTopicNames: gap.dropped,
  };
}

function validateSignalEntry(
  signalId: string,
  val: unknown,
  rawText: string,
): SignalResult {
  if (!val || typeof val !== 'object') {
    throw new EvaluationParseError(`Signal "${signalId}" is not an object`, rawText);
  }
  const v = val as Record<string, unknown>;
  if (typeof v.result !== 'string' || !VALID_RESULTS.has(v.result)) {
    throw new EvaluationParseError(
      `Signal "${signalId}".result must be one of ${[...VALID_RESULTS].join('|')}`,
      rawText,
    );
  }
  if (typeof v.evidence !== 'string') {
    throw new EvaluationParseError(`Signal "${signalId}".evidence must be a string`, rawText);
  }
  if (v.reasoning !== undefined && typeof v.reasoning !== 'string') {
    throw new EvaluationParseError(`Signal "${signalId}".reasoning must be a string`, rawText);
  }
  return {
    result: v.result as SignalResult['result'],
    evidence: v.evidence,
    ...(typeof v.reasoning === 'string' ? { reasoning: v.reasoning } : {}),
  };
}

function extractGapTopics(
  obj: Record<string, unknown>,
  rawText: string,
): { topics: GapTopic[]; dropped: string[] } {
  const raw = (obj.gap_topics ?? obj.gapTopics) as unknown;
  if (raw === undefined || raw === null) return { topics: [], dropped: [] };
  if (!Array.isArray(raw)) {
    throw new EvaluationParseError('"gap_topics" must be an array', rawText);
  }
  const topics: GapTopic[] = [];
  const dropped: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EvaluationParseError('"gap_topics" entries must be objects', rawText);
    }
    const t = item as Record<string, unknown>;
    if (typeof t.name !== 'string') {
      throw new EvaluationParseError('gap_topic.name must be a string', rawText);
    }
    if (!isCanonicalTopic(t.name)) {
      dropped.push(t.name);
      continue;
    }
    if (
      typeof t.coverage !== 'string' ||
      !VALID_GAP_COVERAGES.has(t.coverage as GapTopic['coverage'])
    ) {
      throw new EvaluationParseError(
        `gap_topic.coverage must be one of ${[...VALID_GAP_COVERAGES].join('|')}`,
        rawText,
      );
    }
    const whyExpected = (t.why_expected ?? t.whyExpected) as unknown;
    if (typeof whyExpected !== 'string') {
      throw new EvaluationParseError('gap_topic.why_expected must be a string', rawText);
    }
    topics.push({
      name: t.name,
      coverage: t.coverage as GapTopic['coverage'],
      whyExpected,
    });
  }
  return { topics, dropped };
}
