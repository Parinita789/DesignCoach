import { Injectable, Logger } from '@nestjs/common';
import { BasePhaseAgent } from './base-phase.agent';
import { PhaseEvalInput, PhaseEvaluationResult } from '../types/evaluation.types';
import { Phase } from '../../phase-tagger/types/phase.types';
import { ChatRole } from '../../llm/constants';
import { LlmService } from '../../llm/services/llm.service';
import { RubricLoaderService } from '../services/rubric-loader.service';
import { buildBuildPrompt } from '../prompts/build-prompt';
import { buildBuildEvalTool, SUBMIT_BUILD_EVAL_TOOL_NAME } from '../prompts/build-tool-schema';
import { parseEvalOutput, ParsedEvalOutput } from '../validators/parse-eval-output';
import { validateEvalToolArgs } from '../validators/validate-eval-tool-args';
import { validateEvidence } from '../validators/evidence-validator';
import { computeScore } from '../services/score-computer';
import { truncatePlanMd } from '../helpers/truncate-plan-md';

const BUILD_AGENT_MAX_TOKENS = 4096;
const INPUT_TOKEN_WARN_THRESHOLD = 150_000;

@Injectable()
export class BuildAgent extends BasePhaseAgent {
  protected readonly phase: Phase = 'build';
  private readonly logger = new Logger(BuildAgent.name);

  constructor(llm: LlmService, rubricLoader: RubricLoaderService) {
    super(llm, rubricLoader);
  }

  async evaluate(input: PhaseEvalInput): Promise<PhaseEvaluationResult> {
    const rubric = await this.rubricLoader.load(
      input.rubricVersion,
      'build',
      input.kind ?? undefined,
      input.seniority ?? undefined,
    );
    const useTools = this.llm.supportsToolUse();
    const tool = useTools ? buildBuildEvalTool(rubric) : null;

    const ctx = input.buildContext;
    this.logger.log(
      `Evaluating session ${input.session.id} (build phase, ` +
        `events=${ctx?.events.length ?? 0}, files=${ctx?.finalTree.length ?? 0}, ` +
        `aiTurns=${ctx?.aiTurns.length ?? 0}, useTools=${useTools})`,
    );

    const truncated = truncatePlanMd(input.planMd);
    if (truncated.droppedChars > 0) {
      this.logger.warn(
        `plan.md truncated for build eval: ${truncated.droppedChars.toLocaleString()} chars omitted ` +
          `(kept ${truncated.text.length.toLocaleString()} of ${truncated.originalLength.toLocaleString()})`,
      );
    }
    const inputForPrompt: PhaseEvalInput = { ...input, planMd: truncated.text };

    const { systemBlocks, userMessage } = buildBuildPrompt(rubric, inputForPrompt, { useTools });

    const llmStart = performance.now();
    const llm = await this.llm.call(
      [{ role: ChatRole.User, content: userMessage }],
      {
        system: systemBlocks,
        maxTokens: BUILD_AGENT_MAX_TOKENS,
        temperature: 0,
        ...(tool
          ? {
              tools: [tool],
              toolChoice: { type: 'tool', name: SUBMIT_BUILD_EVAL_TOOL_NAME },
            }
          : {}),
        ...(input.model ? { model: input.model } : {}),
      },
    );
    const latencyMs = Math.round(performance.now() - llmStart);

    this.logger.log(
      `LLM responded in ${latencyMs}ms (model=${llm.modelUsed}, in=${llm.tokensIn}, ` +
        `out=${llm.tokensOut}, cacheWrite=${llm.cacheCreationTokens}, ` +
        `cacheRead=${llm.cacheReadTokens}, toolUse=${llm.toolUse ? llm.toolUse.name : 'none'})`,
    );

    const totalInputTokens =
      llm.tokensIn + llm.cacheCreationTokens + llm.cacheReadTokens;
    if (totalInputTokens > INPUT_TOKEN_WARN_THRESHOLD) {
      this.logger.warn(
        `Input tokens ${totalInputTokens.toLocaleString()} exceed ` +
          `${INPUT_TOKEN_WARN_THRESHOLD.toLocaleString()} threshold ` +
          '- at risk of overflow on smaller-context models. Consider tightening selectBuildContext caps.',
      );
    }

    const expectedSignalIds = new Set(rubric.signals.map((s) => s.id));
    let parsed: ParsedEvalOutput;
    let auditResponse: string;
    if (llm.toolUse && llm.toolUse.name === SUBMIT_BUILD_EVAL_TOOL_NAME) {
      parsed = validateEvalToolArgs(llm.toolUse.input, expectedSignalIds);
      auditResponse = JSON.stringify(llm.toolUse.input, null, 2);
    } else {
      parsed = parseEvalOutput(llm.text, expectedSignalIds);
      auditResponse = llm.text;
    }
    if (parsed.droppedSignalIds && parsed.droppedSignalIds.length > 0) {
      this.logger.warn(
        `Dropped ${parsed.droppedSignalIds.length} hallucinated signal id(s) ` +
          `not in build rubric: ${parsed.droppedSignalIds.join(', ')}`,
      );
    }
    if (parsed.droppedTopicNames && parsed.droppedTopicNames.length > 0) {
      this.logger.warn(
        `Dropped ${parsed.droppedTopicNames.length} gap_topic name(s) outside ` +
          `the canonical vocabulary: ${parsed.droppedTopicNames.join(', ')}`,
      );
    }

    const validated = validateEvidence(
      parsed.signals,
      truncated.text,
      buildEvidenceCorpusItems(input, userMessage),
    );
    if (validated.downgraded.length > 0) {
      this.logger.warn(
        `Evidence validator downgraded ${validated.downgraded.length} signal(s) ` +
          `with unverifiable quotes: ${validated.downgraded.join(', ')}`,
      );
    }
    const workingSignals = validated.signals;

    const computed = computeScore(rubric, workingSignals);
    if (Math.abs(computed.score - parsed.score) >= 1) {
      this.logger.warn(
        `LLM score ${parsed.score} disagreed with deterministic score ${computed.score} ` +
          `(ratio=${computed.ratio.toFixed(2)}, good=${computed.goodScore.toFixed(1)}/${computed.maxScore}, ` +
          `bad=${computed.badDeductions.toFixed(1)}). Using deterministic score.`,
      );
    }

    const renderedPrompt =
      systemBlocks.map((b) => b.text).join('\n\n') +
      '\n\n---\n\n' +
      userMessage +
      (tool ? `\n\n[tool: ${tool.name}]\n${JSON.stringify(tool.inputSchema, null, 2)}` : '');

    return {
      phase: this.phase,
      score: computed.score,
      signalResults: workingSignals,
      feedbackText: parsed.feedback,
      topActionableItems: parsed.topActions,
      gapTopics: parsed.gapTopics,
      audit: {
        prompt: renderedPrompt,
        rawResponse: auditResponse,
        modelUsed: llm.modelUsed,
        tokensIn: llm.tokensIn,
        tokensOut: llm.tokensOut,
        cacheReadTokens: llm.cacheReadTokens,
        cacheCreationTokens: llm.cacheCreationTokens,
        latencyMs,
      },
    };
  }
}

function buildEvidenceCorpusItems(
  input: PhaseEvalInput,
  renderedUserMessage: string,
): Array<{ prompt: string; response: string }> {
  const items: Array<{ prompt: string; response: string }> = input.hints.map((h) => ({
    prompt: h.prompt,
    response: h.response,
  }));
  items.push({ prompt: 'rendered-user-message', response: renderedUserMessage });

  const ctx = input.buildContext;
  if (!ctx) return items;

  for (const f of ctx.allFileContents) {
    items.push({ prompt: f.path, response: f.content });
  }
  return items;
}
