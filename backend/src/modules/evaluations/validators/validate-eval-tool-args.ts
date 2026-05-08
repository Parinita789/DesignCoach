// Tool-use args validator: the LLM provided structured tool input
// rather than free-form JSON text, so the only I/O work is
// type-checking the top-level shape and pretty-printing for audit
// errors. All per-field schema validation is delegated to
// validateEvalObject in eval-output.shared.ts.

import {
  EvaluationParseError,
  ParsedEvalOutput,
  validateEvalObject,
} from './eval-output.shared';

export function validateEvalToolArgs(
  rawArgs: unknown,
  expectedSignalIds: ReadonlySet<string>,
): ParsedEvalOutput {
  const rawText = safeStringify(rawArgs);

  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new EvaluationParseError('Tool args were not a JSON object', rawText);
  }

  // The deterministic score-computer overwrites whatever the LLM
  // claims here, so report 0 for the LLM-claimed score on this path
  // (preserves the historical behavior of validateEvalToolArgs).
  return validateEvalObject(rawArgs as Record<string, unknown>, {
    rawText,
    expectedSignalIds,
    rejectUnknownSignals: true,
    requireAllExpectedSignals: true,
    scoreOverride: 0,
  });
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
