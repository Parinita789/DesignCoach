import { UserContentTag } from '../../common/prompts/wrap-user-content';

export type GuardrailPresetName = 'plan' | 'hint' | 'question';

export interface GuardrailPreset {
  readonly name: GuardrailPresetName;
  readonly maxChars: number;
  readonly minChars: number;
  readonly tag: UserContentTag;
}

// Three preset configs, one per route surface. Adding a fourth is
// one entry below; no other code changes. Each preset binds a
// route's user input to (a) a size envelope and (b) the XML tag
// the content will be wrapped in when it reaches an LLM prompt.
export const GUARDRAIL_PRESETS = {
  plan: {
    name: 'plan',
    maxChars: 100_000,
    minChars: 50,
    tag: 'plan_md',
  },
  hint: {
    name: 'hint',
    maxChars: 2_000,
    minChars: 1,
    tag: 'hint_exchange',
  },
  question: {
    name: 'question',
    maxChars: 5_000,
    minChars: 20,
    tag: 'session_question',
  },
} as const satisfies Record<GuardrailPresetName, GuardrailPreset>;
