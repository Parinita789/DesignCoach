// JSON-text parser for the evaluation output. Strips fences, extracts
// the first balanced JSON object, then defers all per-field schema
// validation to validateEvalObject in eval-output.shared.ts so this
// path and the tool-args path can't drift.
//
// Re-exports EvaluationParseError + ParsedEvalOutput for callers that
// imported them from here historically.

import {
  EvaluationParseError,
  ParsedEvalOutput,
  validateEvalObject,
} from './eval-output.shared';

export { EvaluationParseError, ParsedEvalOutput };

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

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
  return validateEvalObject(candidate as Record<string, unknown>, {
    rawText,
    expectedSignalIds,
    rejectUnknownSignals: false,
    requireAllExpectedSignals: false,
  });
}
