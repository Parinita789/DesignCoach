const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const str = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return raw && raw.trim() ? raw : fallback;
};

const numFromEnv = (key: string): number | null => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const COMPILE_DEFAULT_MODEL = 'claude-opus-4-7';
const GLOBAL_MODEL = str('LLM_MODEL', COMPILE_DEFAULT_MODEL);

// Known model context windows (input + output, in tokens).
// Add a row when Anthropic releases a new model — the unknown-model
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

// Fraction of context window at which to warn about input-token use.
// 0.75 = warn once a single request exceeds 75% of the model's input
// budget. Tuned so normal runs don't trip; sustained warnings mean
// the prompt is genuinely close to the ceiling.
const WARN_FRACTION = 0.75;

// Fraction of context window to allocate to a single plan.md.
// 0.05 = plan.md gets at most 5% of context, leaving room for the
// system prompt, rubric, snapshots, hints, and (build phase) the
// full reconstructed source tree. On a 1M-context model that's 50K
// chars; on a 200K-context Haiku that's 10K chars.
const PLAN_MD_FRACTION = 0.05;

function normalizeModelId(model: string): string {
  // Anthropic sometimes returns date-stamped IDs (e.g.
  // 'claude-opus-4-7-20251010'). The table is keyed by the base ID.
  return model.replace(/-\d{8}$/, '');
}

export function contextWindowFor(model: string): number {
  const ctx = MODEL_CONTEXT_WINDOWS[normalizeModelId(model)];
  if (!ctx) {
    throw new Error(
      `Unknown model "${model}" — add it to MODEL_CONTEXT_WINDOWS in ` +
        `backend/src/config/llm-tunables.config.ts. Anthropic's catalog: ` +
        `https://docs.claude.com/en/docs/about-claude/models`,
    );
  }
  return ctx;
}

// Warn-threshold helper. Env override wins; otherwise WARN_FRACTION
// of the model's context window. Pass the actual model used (from
// llm.modelUsed in the response) so the threshold reflects what the
// provider actually picked, not what was requested.
export function inputTokenWarnThresholdFor(
  model: string,
  envOverrideKey?: string,
): number {
  if (envOverrideKey) {
    const override = numFromEnv(envOverrideKey);
    if (override !== null) return override;
  }
  return Math.floor(contextWindowFor(model) * WARN_FRACTION);
}

// plan.md truncation cap helper. Env override wins; otherwise
// PLAN_MD_FRACTION of the model's context. Pass the intended model
// (input.model ?? agent default) since truncation happens before the
// LLM call.
export function planMdCapFor(
  model: string,
  envOverrideKey?: string,
): number {
  if (envOverrideKey) {
    const override = numFromEnv(envOverrideKey);
    if (override !== null) return override;
  }
  return Math.floor(contextWindowFor(model) * PLAN_MD_FRACTION);
}

export const AGENTS_CONFIG = {
  planAgent: {
    maxTokens: num('PLAN_AGENT_MAX_TOKENS', 4096),
    defaultModel: str('PLAN_AGENT_MODEL', GLOBAL_MODEL),
  },
  buildAgent: {
    maxTokens: num('BUILD_AGENT_MAX_TOKENS', 4096),
    defaultModel: str('BUILD_AGENT_MODEL', GLOBAL_MODEL),
  },
  mentorAgent: {
    maxTokens: num('MENTOR_AGENT_MAX_TOKENS', 4096),
    defaultModel: str('MENTOR_AGENT_MODEL', GLOBAL_MODEL),
  },
  signalMentorAgent: {
    maxTokens: num('SIGNAL_MENTOR_AGENT_MAX_TOKENS', 4096),
    defaultModel: str('SIGNAL_MENTOR_AGENT_MODEL', GLOBAL_MODEL),
  },
  hints: {
    maxTokens: num('HINTS_MAX_TOKENS', 1024),
  },
  patternDrillGrader: {
    maxTokens: num('PATTERN_DRILL_GRADER_MAX_TOKENS', 2048),
    defaultModel: str('PATTERN_DRILL_GRADER_MODEL', GLOBAL_MODEL),
  },
  buildContext: {
    topKeyFiles: num('BUILD_CONTEXT_TOP_KEY_FILES', 5),
    keyFileMaxChars: num('BUILD_CONTEXT_KEY_FILE_MAX_CHARS', 4000),
  },
} as const;
