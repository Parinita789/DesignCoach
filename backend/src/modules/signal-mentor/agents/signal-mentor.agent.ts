import { Injectable, Logger } from '@nestjs/common';
import { ChatRole } from '../../llm/constants';
import { LlmService } from '../../llm/services/llm.service';
import { truncatePlanMd } from '../../evaluations/helpers/truncate-plan-md';
import {
  buildSignalMentorPrompt,
  buildAnnotationsTool,
  flattenForAudit,
  SUBMIT_ANNOTATIONS_TOOL_NAME,
} from '../prompts/signal-mentor-prompt';
import { SignalMentorInput, SignalMentorResult } from '../types/signal-mentor.types';
import {
  AGENTS_CONFIG,
  inputTokenWarnThresholdFor,
  planMdCapFor,
} from '../../../config/llm-tunables.config';

@Injectable()
export class SignalMentorAgent {
  private readonly logger = new Logger(SignalMentorAgent.name);

  constructor(private readonly llm: LlmService) {}

  async generate(input: SignalMentorInput): Promise<SignalMentorResult> {
    const intendedModel = input.model ?? AGENTS_CONFIG.signalMentorAgent.defaultModel;
    const truncated = truncatePlanMd(
      input.planMd,
      planMdCapFor(intendedModel, 'PLAN_MD_TRUNCATION_CAP'),
    );
    if (truncated.droppedChars > 0) {
      this.logger.warn(
        `plan.md truncated for signal-mentor: ${truncated.droppedChars.toLocaleString()} chars omitted ` +
          `(kept ${truncated.text.length.toLocaleString()} of ${truncated.originalLength.toLocaleString()})`,
      );
    }
    const inputForPrompt: SignalMentorInput = { ...input, planMd: truncated.text };

    const built = buildSignalMentorPrompt(inputForPrompt);
    const renderedPrompt = flattenForAudit(built);

    const useTools = this.llm.supportsToolUse();
    const gapIds = input.gaps.map((g) => g.signal.id);
    const tool = useTools ? buildAnnotationsTool(gapIds) : null;

    this.logger.log(
      `Generating signal-mentor for eval ${input.evaluationId} ` +
        `(planMd=${truncated.text.length} chars, gaps=${gapIds.length}, useTools=${useTools})`,
    );

    const llmStart = performance.now();
    const response = await this.llm.call(
      [{ role: ChatRole.User, content: built.userMessage }],
      {
        system: built.systemBlocks,
        maxTokens: AGENTS_CONFIG.signalMentorAgent.maxTokens,
        temperature: 0,
        ...(tool
          ? { tools: [tool], toolChoice: { type: 'tool', name: SUBMIT_ANNOTATIONS_TOOL_NAME } }
          : {}),
        model: intendedModel,
        userId: input.userId,
        route: 'signal-mentor.generate',
      },
    );
    const latencyMs = Math.round(performance.now() - llmStart);

    this.logger.log(
      `Signal-mentor ready in ${latencyMs}ms ` +
        `(model=${response.modelUsed}, in=${response.tokensIn}, out=${response.tokensOut}, ` +
        `cacheWrite=${response.cacheCreationTokens}, cacheRead=${response.cacheReadTokens}, ` +
        `toolUse=${response.toolUse ? response.toolUse.name : 'none'})`,
    );

    const totalInputTokens =
      response.tokensIn + response.cacheCreationTokens + response.cacheReadTokens;
    const warnThreshold = inputTokenWarnThresholdFor(
      response.modelUsed,
      'SIGNAL_MENTOR_AGENT_INPUT_TOKEN_WARN',
    );
    if (totalInputTokens > warnThreshold) {
      this.logger.warn(
        `Signal-mentor input tokens ${totalInputTokens.toLocaleString()} exceed ` +
          `${warnThreshold.toLocaleString()} threshold ` +
          `for model ${response.modelUsed}.`,
      );
    }

    const expected = new Set(gapIds);
    let annotations: Record<string, string>;
    if (response.toolUse && response.toolUse.name === SUBMIT_ANNOTATIONS_TOOL_NAME) {
      annotations = parseAnnotationsFromObject(response.toolUse.input, expected);
    } else {
      annotations = parseAnnotationsFromText(response.text, expected);
    }

    const dropped = Object.keys(annotations).filter((id) => !expected.has(id));
    if (dropped.length > 0) {
      this.logger.warn(
        `Signal-mentor returned unknown signal id(s) not in gap set: ${dropped.join(', ')}`,
      );
      for (const id of dropped) delete annotations[id];
    }

    const missing = gapIds.filter((id) => !annotations[id] || !annotations[id].trim());
    if (missing.length > 0) {
      this.logger.warn(
        `Signal-mentor missing annotations for ${missing.length} gap signal(s): ${missing.join(', ')}`,
      );
    }

    return {
      artifact: { annotations },
      renderedPrompt,
      audit: {
        modelUsed: response.modelUsed,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        cacheReadTokens: response.cacheReadTokens,
        cacheCreationTokens: response.cacheCreationTokens,
        latencyMs,
      },
    };
  }
}

function parseAnnotationsFromObject(
  raw: unknown,
  expected: ReadonlySet<string>,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!expected.has(key)) continue;
    out[key] = value.trim();
  }
  return out;
}

function parseAnnotationsFromText(
  rawText: string,
  expected: ReadonlySet<string>,
): Record<string, string> {
  if (!rawText) return {};
  const cleaned = stripFences(rawText);
  let candidate: unknown;
  try {
    candidate = JSON.parse(cleaned);
  } catch {
    const extracted = extractJsonObject(cleaned);
    if (!extracted) return {};
    try {
      candidate = JSON.parse(extracted);
    } catch {
      return {};
    }
  }
  if (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    'annotations' in candidate
  ) {
    return parseAnnotationsFromObject(
      (candidate as { annotations: unknown }).annotations,
      expected,
    );
  }
  return parseAnnotationsFromObject(candidate, expected);
}

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
