import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SessionReadService } from '../../session-read/services/session-read.service';
import { SnapshotsService } from '../../snapshots/services/snapshots.service';
import { LlmService } from '../../llm/services/llm.service';
import { ChatMessage } from '../../llm/types/llm.types';
import { ChatRole } from '../../llm/constants';
import { AIInteractionsRepository } from '../repositories/ai-interactions.repository';
import { AGENTS_CONFIG } from '../../../config/llm-tunables.config';
import { HINT_SYSTEM_PROMPT } from '../prompts/hint-system-prompt';
import { OwnershipService } from '../../auth/services/ownership.service';

@Injectable()
export class HintsService {
  constructor(
    private readonly sessionReadService: SessionReadService,
    private readonly snapshotsService: SnapshotsService,
    private readonly llmService: LlmService,
    private readonly aiInteractionsRepo: AIInteractionsRepository,
    private readonly ownership: OwnershipService,
  ) {}

  async send(sessionId: string, message: string, userId: string) {
    // Single sessions-table fetch covers both ownership check + the
    // session+question read we need anyway. SessionReadService throws
    // NotFoundException if the row is missing; we inline-check userId
    // before doing anything else.
    const session = await this.sessionReadService.getWithQuestion(sessionId);
    if (session.userId !== userId) {
      throw new ForbiddenException(`Session ${sessionId} is not owned by the current user`);
    }
    const latestSnapshot = await this.snapshotsService.latest(sessionId);
    const planMd = (latestSnapshot?.artifacts as { planMd?: string | null } | null)?.planMd ?? null;

    const history = await this.aiInteractionsRepo.findBySession(sessionId);
    const messages: ChatMessage[] = [];
    for (const turn of history) {
      messages.push({ role: ChatRole.User, content: turn.prompt });
      messages.push({ role: ChatRole.Assistant, content: turn.response });
    }

    const latestUserContent = planMd
      ? `[Current plan.md]\n${planMd}\n\n[Question]\n${message}`
      : `[plan.md is empty]\n\n[Question]\n${message}`;
    messages.push({ role: ChatRole.User, content: latestUserContent });

    const llmResponse = await this.llmService.call(messages, {
      system: [
        { text: HINT_SYSTEM_PROMPT, cacheable: true },
        { text: `## Session question\n${session.question.prompt}`, cacheable: true },
      ],
      maxTokens: AGENTS_CONFIG.hints.maxTokens,
      userId,
      route: 'hints.send',
    });

    const elapsedMinutes = Math.floor(
      (Date.now() - new Date(session.startedAt).getTime()) / 60000,
    );

    return this.aiInteractionsRepo.create({
      sessionId,
      occurredAt: new Date(),
      elapsedMinutes,
      inferredPhase: null,
      prompt: message,
      response: llmResponse.text,
      modelUsed: llmResponse.modelUsed,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
      artifactStateAtPrompt: { planMd } as Prisma.InputJsonValue,
    });
  }

  async list(sessionId: string, userId: string) {
    await this.ownership.assertOwnsSession(sessionId, userId);
    return this.aiInteractionsRepo.findBySession(sessionId);
  }
}
