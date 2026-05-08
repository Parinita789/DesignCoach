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

const VALID_GAP_COVERAGES = new Set<GapTopic['coverage']>([
  'missed',
  'lightly_touched',
]);

const VALID_RESULTS = new Set(['hit', 'miss', 'partial', 'cannot_evaluate']);

// Strip optional ```json ... ``` or ``` ... ``` fences if present.
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

// Smaller LLMs (llama3, gemma, etc.) often preface JSON with prose like
// "Here is the JSON: { ... }". Extract the first balanced {…} object.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseEvalOutput(
  rawText: string,
  expectedSignalIds?: ReadonlySet<string>,
): ParsedEvalOutput {
  let candidate: unknown;
  const cleaned = stripFences(rawText);
  try {
    candidate = JSON.parse(cleaned);
  } catch {
    // Fallback: extract a balanced JSON object out of surrounding prose.
    const extracted = extractJsonObject(cleaned);
    if (extracted) {
      try {
        candidate = JSON.parse(extracted);
      } catch (err2) {
        throw new EvaluationParseError(
          `LLM returned malformed JSON even after extraction: ${(err2 as Error).message}`,
          rawText,
        );
      }
    } else {
      throw new EvaluationParseError(
        `LLM did not return any JSON object`,
        rawText,
      );
    }
  }

  if (!candidate || typeof candidate !== 'object') {
    throw new EvaluationParseError('LLM output was not a JSON object', rawText);
  }
  const obj = candidate as Record<string, unknown>;

  // score is optional — computeScore overrides it deterministically downstream.
  // Accept any number; default to 0 when absent or non-numeric so the rest of
  // the pipeline still runs.
  const scoreCandidate = obj.score;
  const score =
    typeof scoreCandidate === 'number' && !Number.isNaN(scoreCandidate)
      ? scoreCandidate
      : 0;

  // signals
  if (!obj.signals || typeof obj.signals !== 'object') {
    throw new EvaluationParseError('Missing or invalid "signals" object', rawText);
  }
  const signals: Record<string, SignalResult> = {};
  const droppedSignalIds: string[] = [];
  for (const [signalId, val] of Object.entries(obj.signals as Record<string, unknown>)) {
    if (expectedSignalIds && !expectedSignalIds.has(signalId)) {
      droppedSignalIds.push(signalId);
      continue;
    }
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
    signals[signalId] = {
      result: v.result as SignalResult['result'],
      evidence: v.evidence,
    };
  }

  // feedback
  const feedback = obj.feedback;
  if (typeof feedback !== 'string') {
    throw new EvaluationParseError('Missing or non-string "feedback"', rawText);
  }

  // top_actions (camelCase or snake_case — accept either)
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

  const gapResult = extractGapTopics(obj, rawText);

  return {
    score,
    signals,
    feedback,
    topActions,
    gapTopics: gapResult.topics,
    droppedSignalIds,
    droppedTopicNames: gapResult.dropped,
  };
}

// gap_topics is optional on the wire (some old prompts won't return it)
// and on the no-tools text path we tolerate missing/empty arrays.
// Out-of-canonical names are dropped with a warn rather than throwing —
// mirrors the signal-id drop behavior.
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
    if (typeof t.coverage !== 'string' || !VALID_GAP_COVERAGES.has(t.coverage as GapTopic['coverage'])) {
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
