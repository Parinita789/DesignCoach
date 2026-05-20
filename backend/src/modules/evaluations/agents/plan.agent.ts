import { Injectable, Logger } from '@nestjs/common';
import { BasePhaseAgent } from './base-phase.agent';
import { PhaseEvalInput } from '../types/evaluation.types';
import { Phase } from '../../phase-tagger/types/phase.types';
import { PhaseEvaluationResult } from '../types/evaluation.types';
import { ChatRole } from '../../llm/constants';
import { LlmService } from '../../llm/services/llm.service';
import { RubricLoaderService } from '../services/rubric-loader.service';
import { buildPlanPrompt } from '../prompts/plan-prompt';
import { buildPlanEvalTool, SUBMIT_EVAL_TOOL_NAME } from '../prompts/plan-tool-schema';
import { parseEvalOutput, ParsedEvalOutput } from '../validators/parse-eval-output';
import { validateEvalToolArgs } from '../validators/validate-eval-tool-args';
import { validateEvidence } from '../validators/evidence-validator';
import { computeScore } from '../services/score-computer';
import { truncatePlanMd } from '../helpers/truncate-plan-md';
import {
  AGENTS_CONFIG,
  inputTokenWarnThresholdFor,
  planMdCapFor,
} from '../../../config/llm-tunables.config';

@Injectable()
export class PlanAgent extends BasePhaseAgent {
  protected readonly phase: Phase = 'plan';
  private readonly logger = new Logger(PlanAgent.name);

  constructor(llm: LlmService, rubricLoader: RubricLoaderService) {
    super(llm, rubricLoader);
  }

  async evaluate(input: PhaseEvalInput): Promise<PhaseEvaluationResult> {
    const rubric = await this.rubricLoader.load(
      input.rubricVersion,
      'plan',
      input.kind ?? undefined,
      input.seniority ?? undefined,
    );
    const useTools = this.llm.supportsToolUse();
    const tool = useTools ? buildPlanEvalTool(rubric) : null;

    const intendedModel = input.model ?? AGENTS_CONFIG.planAgent.defaultModel;
    const truncated = truncatePlanMd(
      input.planMd,
      planMdCapFor(intendedModel, 'PLAN_MD_TRUNCATION_CAP'),
    );
    if (truncated.droppedChars > 0) {
      this.logger.warn(
        `plan.md truncated: ${truncated.droppedChars.toLocaleString()} chars omitted ` +
          `(kept ${truncated.text.length.toLocaleString()} of ${truncated.originalLength.toLocaleString()})`,
      );
    }
    const inputForPrompt: PhaseEvalInput = { ...input, planMd: truncated.text };

    const { systemBlocks, userMessage, preprocessing } = buildPlanPrompt(rubric, inputForPrompt, {
      useTools,
    });

    this.logger.log(
      `Evaluating session ${input.session.id} (planMd=${truncated.text.length} chars, ` +
        `${input.snapshots.length} snapshots, ${input.hints.length} hints, ` +
        `useTools=${useTools})`,
    );
    if (preprocessing.removedParagraphs > 0) {
      this.logger.log(
        `Stripped ${preprocessing.removedParagraphs} duplicate paragraph(s) ` +
          `from plan.md before LLM call (saved ${preprocessing.removedChars} chars)`,
      );
    }

    const llmStart = performance.now();
    const llm = await this.llm.call(
      [{ role: ChatRole.User, content: userMessage }],
      {
        system: systemBlocks,
        maxTokens: AGENTS_CONFIG.planAgent.maxTokens,
        temperature: 0,
        ...(tool
          ? {
              tools: [tool],
              toolChoice: { type: 'tool', name: SUBMIT_EVAL_TOOL_NAME },
            }
          : {}),
        model: intendedModel,
        userId: input.userId,
        route: 'plan.evaluate',
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
    const warnThreshold = inputTokenWarnThresholdFor(
      llm.modelUsed,
      'PLAN_AGENT_INPUT_TOKEN_WARN',
    );
    if (totalInputTokens > warnThreshold) {
      this.logger.warn(
        `Input tokens ${totalInputTokens.toLocaleString()} exceed ` +
          `${warnThreshold.toLocaleString()} threshold ` +
          `for model ${llm.modelUsed} — consider lowering PLAN_MD_TRUNCATION_CAP ` +
          `or selecting a larger-context model.`,
      );
    }

    const expectedSignalIds = new Set(rubric.signals.map((s) => s.id));
    let parsed: ParsedEvalOutput;
    let auditResponse: string;
    if (llm.toolUse && llm.toolUse.name === SUBMIT_EVAL_TOOL_NAME) {
      parsed = validateEvalToolArgs(llm.toolUse.input, expectedSignalIds);
      auditResponse = JSON.stringify(llm.toolUse.input, null, 2);
    } else {
      parsed = parseEvalOutput(llm.text, expectedSignalIds);
      auditResponse = llm.text;
    }
    if (parsed.droppedSignalIds && parsed.droppedSignalIds.length > 0) {
      this.logger.warn(
        `Dropped ${parsed.droppedSignalIds.length} hallucinated signal id(s) ` +
          `not in rubric: ${parsed.droppedSignalIds.join(', ')}`,
      );
    }
    if (parsed.droppedTopicNames && parsed.droppedTopicNames.length > 0) {
      this.logger.warn(
        `Dropped ${parsed.droppedTopicNames.length} gap_topic name(s) outside ` +
          `the canonical vocabulary: ${parsed.droppedTopicNames.join(', ')}`,
      );
    }

    const validated = validateEvidence(parsed.signals, truncated.text, input.hints);
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
          `bad=${computed.badDeductions.toFixed(1)}, highWeightMissed=[${computed.highWeightGoodMissed.join(',')}]). ` +
          `Using deterministic score.`,
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
        llmScore: parsed.score,
      },
    };
  }
}
