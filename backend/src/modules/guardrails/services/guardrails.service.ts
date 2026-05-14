import { Injectable } from '@nestjs/common';
import {
  escapeClosingTag,
  USER_CONTENT_TAGS,
} from '../../../common/prompts/wrap-user-content';
import { GuardrailPreset } from '../presets';
import { GuardrailMetadata, GuardrailResult } from '../types';
import {
  GuardrailRejectedError,
  GuardrailRejectionCode,
} from '../errors';

// Internally a pure function; the @Injectable service is a thin
// wrapper so callers can use either form. The pure function is also
// what makes this module framework-portable — a future caller
// outside NestJS (script, CLI, alternative framework) can `import
// { guardInput } from 'backend/src/modules/guardrails'` without
// touching DI.
export function guardInput(
  input: unknown,
  preset: GuardrailPreset,
): GuardrailResult {
  // 1. Type check
  if (typeof input !== 'string') {
    throw new GuardrailRejectedError(
      GuardrailRejectionCode.NOT_A_STRING,
      preset.name,
      0,
      null,
    );
  }

  const originalLength = input.length;
  const trimmed = input.trim();
  const sanitizedLength = trimmed.length;

  // 2. Empty-after-trim (before size checks: a 100k-char whitespace
  //    string is conceptually empty, not "too long").
  if (sanitizedLength === 0) {
    throw new GuardrailRejectedError(
      GuardrailRejectionCode.EMPTY_AFTER_TRIM,
      preset.name,
      originalLength,
      null,
    );
  }

  // 3. Min / max checks — cap is measured against the trimmed
  //    length, not the original. Trimming whitespace doesn't game
  //    the cap; user-meaningful characters are what count.
  if (sanitizedLength < preset.minChars) {
    throw new GuardrailRejectedError(
      GuardrailRejectionCode.TOO_SHORT,
      preset.name,
      sanitizedLength,
      preset.minChars,
    );
  }
  if (sanitizedLength > preset.maxChars) {
    throw new GuardrailRejectedError(
      GuardrailRejectionCode.TOO_LONG,
      preset.name,
      sanitizedLength,
      preset.maxChars,
    );
  }

  // 4. Closing-tag escape — neutralize any literal `</preset.tag>`
  //    in the content so it can't prematurely close the boundary
  //    once wrapped. wrap-user-content also calls escapeClosingTag
  //    internally, so this is technically a double-application, but
  //    escape is idempotent (escaped form is no longer a match).
  const { escaped: sanitized, count: closingTagOccurrencesEscaped } =
    escapeClosingTag(trimmed, preset.tag);

  // 5. Wrap for LLM consumption
  const wrapped = `<${preset.tag}>\n${sanitized}\n</${preset.tag}>`;

  const metadata: GuardrailMetadata = {
    preset: preset.name,
    originalLength,
    sanitizedLength,
    closingTagOccurrencesEscaped,
  };

  return { sanitized, wrapped, metadata };
}

// Re-export USER_CONTENT_TAGS for tests that need the tag names
// without importing across module boundaries.
export { USER_CONTENT_TAGS };

@Injectable()
export class GuardrailsService {
  guard(input: unknown, preset: GuardrailPreset): GuardrailResult {
    return guardInput(input, preset);
  }
}
