import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { BuildAIInteractionDto } from '../dto/build-ai-interaction.dto';

@Injectable()
export class BuildAIInteractionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // skipDuplicates relies on the (sessionId, externalSessionId, turnIndex)
  // unique index — a re-shipped batch from a wiped CLI cursor file
  // silently coalesces instead of double-writing.
  async insertBatch(sessionId: string, interactions: BuildAIInteractionDto[]): Promise<number> {
    if (interactions.length === 0) return 0;
    const rows = interactions.map((i) => ({
      sessionId,
      tool: i.tool,
      externalSessionId: i.externalSessionId,
      turnIndex: i.turnIndex,
      role: i.role,
      text: i.text ?? null,
      toolName: i.toolName ?? null,
      toolInputSummary: i.toolInputSummary ?? null,
      toolResultSummary: i.toolResultSummary ?? null,
      occurredAt: new Date(i.occurredAt),
    }));
    const result = await this.prisma.buildAIInteraction.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return result.count;
  }

  async countsForSession(sessionId: string): Promise<{
    total: number;
    distinctSessions: number;
  }> {
    const [total, distinct] = await Promise.all([
      this.prisma.buildAIInteraction.count({ where: { sessionId } }),
      this.prisma.buildAIInteraction.findMany({
        where: { sessionId },
        select: { externalSessionId: true },
        distinct: ['externalSessionId'],
      }),
    ]);
    return { total, distinctSessions: distinct.length };
  }
}
