import { GuardrailPresetName } from './presets';

export interface GuardrailMetadata {
  preset: GuardrailPresetName;
  originalLength: number;
  sanitizedLength: number;
  closingTagOccurrencesEscaped: number;
}

export interface GuardrailResult {
  // Trimmed and closing-tag-escaped form of the input. Safe to
  // persist as-is — the escape leaves the string human-readable.
  sanitized: string;

  // The sanitized content wrapped in the preset's XML tag. Drop this
  // directly into an LLM prompt; the wrap-user-content BOUNDARY_NOTICE
  // already informs the model that anything inside such tags is
  // data, not directives.
  wrapped: string;

  // Counts only — safe to log. No content is included.
  metadata: GuardrailMetadata;
}
