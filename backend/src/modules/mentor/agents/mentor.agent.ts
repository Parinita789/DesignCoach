import { Injectable, Logger } from '@nestjs/common';
import { ChatRole } from '../../llm/constants';
import { LlmService } from '../../llm/services/llm.service';
import { truncatePlanMd } from '../../evaluations/helpers/truncate-plan-md';
import { buildMentorPrompt, flattenForAudit } from '../prompts/mentor-prompt';
import { MentorInput, MentorResult } from '../types/mentor.types';
import {
  AGENTS_CONFIG,
  inputTokenWarnThresholdFor,
  planMdCapFor,
} from '../../../config/llm-tunables.config';

@Injectable()
export class MentorAgent {
  private readonly logger = new Logger(MentorAgent.name);

  constructor(private readonly llm: LlmService) {}

  async generate(input: MentorInput): Promise<MentorResult> {
    const intendedModel = input.model ?? AGENTS_CONFIG.mentorAgent.defaultModel;
    const truncated = truncatePlanMd(
      input.planMd,
      planMdCapFor(intendedModel, 'PLAN_MD_TRUNCATION_CAP'),
    );
    if (truncated.droppedChars > 0) {
      this.logger.warn(
        `plan.md truncated for mentor: ${truncated.droppedChars.toLocaleString()} chars omitted ` +
          `(kept ${truncated.text.length.toLocaleString()} of ${truncated.originalLength.toLocaleString()})`,
      );
    }
    const inputForPrompt: MentorInput = { ...input, planMd: truncated.text };

    const built = buildMentorPrompt(inputForPrompt);
    const renderedPrompt = flattenForAudit(built);

    this.logger.log(
      `Generating mentor artifact for eval ${input.evaluationId} ` +
        `(planMd=${truncated.text.length} chars, ` +
        `signals=${Object.keys(input.signalResults).length})`,
    );

    const llmStart = performance.now();
    const response = await this.llm.call(
      [{ role: ChatRole.User, content: built.userMessage }],
      {
        system: built.systemBlocks,
        maxTokens: AGENTS_CONFIG.mentorAgent.maxTokens,
        temperature: 0,
        model: intendedModel,
        userId: input.userId,
        route: 'mentor.generate',
      },
    );
    const latencyMs = Math.round(performance.now() - llmStart);

    this.logger.log(
      `Mentor artifact ready in ${latencyMs}ms ` +
        `(model=${response.modelUsed}, in=${response.tokensIn}, ` +
        `out=${response.tokensOut}, cacheWrite=${response.cacheCreationTokens}, ` +
        `cacheRead=${response.cacheReadTokens})`,
    );

    const totalInputTokens =
      response.tokensIn + response.cacheCreationTokens + response.cacheReadTokens;
    const warnThreshold = inputTokenWarnThresholdFor(
      response.modelUsed,
      'MENTOR_AGENT_INPUT_TOKEN_WARN',
    );
    if (totalInputTokens > warnThreshold) {
      this.logger.warn(
        `Mentor input tokens ${totalInputTokens.toLocaleString()} exceed ` +
          `${warnThreshold.toLocaleString()} threshold ` +
          `for model ${response.modelUsed}.`,
      );
    }

    return {
      artifact: { content: (response.text ?? '').trim() },
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
