import { BadRequestException } from '@nestjs/common';
import { GuardrailPresetName } from './presets';

export enum GuardrailRejectionCode {
  NOT_A_STRING = 'NOT_A_STRING',
  TOO_SHORT = 'TOO_SHORT',
  TOO_LONG = 'TOO_LONG',
  EMPTY_AFTER_TRIM = 'EMPTY_AFTER_TRIM',
}

// Extends BadRequestException so the global AllExceptionsFilter at
// backend/src/common/filters/all-exceptions.filter.ts maps it to
// HTTP 400 with a structured body — no controller-level catch
// needed. Frontends can branch on `code` to show a specific message
// ("hint too long" vs "hint too short").
export class GuardrailRejectedError extends BadRequestException {
  constructor(
    public readonly code: GuardrailRejectionCode,
    public readonly preset: GuardrailPresetName,
    public readonly observedLength: number,
    public readonly limit: number | null,
  ) {
    super({
      statusCode: 400,
      error: 'Bad Request',
      code,
      preset,
      observedLength,
      limit,
      message: humanMessage(code, preset, observedLength, limit),
    });
  }
}

// Formats the human-readable message that ends up in the HTTP body
// and the server log line. By construction this function has NO
// access to the rejected content — the signature only takes
// counts, codes, and the preset name. There is no code path by
// which `content` can leak into a log line.
function humanMessage(
  code: GuardrailRejectionCode,
  preset: GuardrailPresetName,
  observedLength: number,
  limit: number | null,
): string {
  switch (code) {
    case GuardrailRejectionCode.NOT_A_STRING:
      return `Expected a string for the ${preset} input.`;
    case GuardrailRejectionCode.EMPTY_AFTER_TRIM:
      return `The ${preset} input was empty (whitespace only).`;
    case GuardrailRejectionCode.TOO_SHORT:
      return `The ${preset} input is too short (${observedLength} chars, minimum ${limit}).`;
    case GuardrailRejectionCode.TOO_LONG:
      return `The ${preset} input is too long (${observedLength} chars, maximum ${limit}).`;
  }
}
