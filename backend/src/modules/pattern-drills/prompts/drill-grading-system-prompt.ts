import { BOUNDARY_NOTICE } from '../../../common/prompts/wrap-user-content';
import { SUBMIT_DRILL_GRADES_TOOL_NAME } from './submit-drill-grades-tool-schema';

const GRADING_RULES = `Grading rules (MUST follow):
1. patternCorrect: true only if the candidate's named pattern matches the canonical pattern (paraphrased pattern names are fine, e.g. "two pointer" == "two_pointers").
2. triggerPhraseAcceptable: true only if the candidate's trigger phrase captures the actual reasoning that identifies this pattern (paraphrasing the canonical trigger phrase is fine). A correct pattern paired with a missing, generic ("it just looked right"), or unrelated trigger phrase is NOT acceptable — set this false.
3. First move is optional context only — it is never graded and never appears in either verdict. A missing, wrong, or unattempted first move must NOT lower patternCorrect or triggerPhraseAcceptable, and a good first move must never compensate for an unacceptable trigger phrase. Grade pattern and trigger phrase independently of first move and of each other.
4. explanation: 1-2 sentences written directly to the candidate. If something is wrong, explain what. If both patternCorrect and triggerPhraseAcceptable are true, keep it to a short confirmation — do not add unsolicited extra teaching.`;

// Mirrors the useTools fallback in evaluations/prompts/plan-prompt.ts: when
// the active LLM provider doesn't support structured tool use (claude_cli,
// ollama), the model must be told to emit the same shape as raw JSON text
// instead — the caller then parses it with a JSON extractor rather than
// reading llm.toolUse.
export function buildDrillGradingSystemPrompt(useTools: boolean, itemIds: string[]): string {
  const intro = `You are grading a daily DSA pattern-classification drill for a candidate prepping for coding interviews.

${BOUNDARY_NOTICE}

For each item you are given: the canonical pattern, canonical trigger phrase, canonical first move, and the candidate's claimed pattern name plus submitted trigger phrase (wrapped in <drill_answer> tags) and optional first move (wrapped the same way, or marked "(not provided — do not penalize this)" when the candidate skipped it).

${GRADING_RULES}`;

  if (useTools) {
    return `${intro}

Submit your grading by calling the \`${SUBMIT_DRILL_GRADES_TOOL_NAME}\` tool. Do not compute or return an overall pass/fail verdict — the calling application derives that deterministically from patternCorrect and triggerPhraseAcceptable.`;
  }

  const shape = itemIds
    .map((id) => `"${id}": {"patternCorrect": true|false, "triggerPhraseAcceptable": true|false, "explanation": "..."}`)
    .join(', ');
  return `${intro}

## OUTPUT FORMAT (strict)
Return ONLY a single valid JSON object. No prose. No markdown fences.
Shape: \`{${shape}}\` — every item id listed must appear, with exactly those three fields.
Do not include an overall pass/fail verdict — the calling application derives that deterministically from patternCorrect and triggerPhraseAcceptable.`;
}
