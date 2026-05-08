import { Injectable, Logger } from '@nestjs/common';
import { ChatRole } from '../../llm/constants';
import { LlmService } from '../../llm/services/llm.service';
import { truncatePlanMd } from '../../evaluations/helpers/truncate-plan-md';
import { buildMentorPrompt, flattenForAudit } from '../prompts/mentor-prompt';
import { MentorInput, MentorResult } from '../types/mentor.types';

const MENTOR_AGENT_MAX_TOKENS = 4096;
const INPUT_TOKEN_WARN_THRESHOLD = 150_000;

@Injectable()
export class MentorAgent {
  private readonly logger = new Logger(MentorAgent.name);

  constructor(private readonly llm: LlmService) {}

  async generate(input: MentorInput): Promise<MentorResult> {
    const truncated = truncatePlanMd(input.planMd);
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
        maxTokens: MENTOR_AGENT_MAX_TOKENS,
        temperature: 0,
        ...(input.model ? { model: input.model } : {}),
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
    if (totalInputTokens > INPUT_TOKEN_WARN_THRESHOLD) {
      this.logger.warn(
        `Mentor input tokens ${totalInputTokens.toLocaleString()} exceed ` +
          `${INPUT_TOKEN_WARN_THRESHOLD.toLocaleString()} threshold ` +
          `— at risk of overflow on smaller-context models.`,
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
