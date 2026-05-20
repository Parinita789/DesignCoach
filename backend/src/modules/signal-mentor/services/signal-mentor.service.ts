import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { safeJoinUnderBase } from '../../../common/paths/safe-join';
import { BackgroundTaskTracker } from '../../../common/background-task-tracker.service';
import { EvaluationCompletedEvent } from '../../../common/events/evaluation-events';
import { EvaluationsRepository } from '../../evaluations/repositories/evaluations.repository';
import { RubricLoaderService } from '../../evaluations/services/rubric-loader.service';
import { BuildContextService } from '../../evaluations/services/build-context.service';
import { gapSignalIds } from '../../evaluations/helpers/gap-signals';
import { SessionReadService } from '../../session-read/services/session-read.service';
import { SnapshotsService } from '../../snapshots/services/snapshots.service';
import { SignalResult } from '../../evaluations/types/evaluation.types';
import { Phase } from '../../phase-tagger/types/phase.types';
import { SignalMentorAgent } from '../agents/signal-mentor.agent';
import { SignalMentorRepository } from '../repositories/signal-mentor.repository';
import {
  GapSignalContext,
  SignalMentorInput,
  SignalMentorResult,
} from '../types/signal-mentor.types';

@Injectable()
export class SignalMentorService {
  private readonly logger = new Logger(SignalMentorService.name);

  constructor(
    private readonly agent: SignalMentorAgent,
    private readonly repo: SignalMentorRepository,
    private readonly evalRepo: EvaluationsRepository,
    private readonly rubricLoader: RubricLoaderService,
    private readonly sessionReadService: SessionReadService,
    private readonly snapshotsService: SnapshotsService,
    private readonly buildContextSvc: BuildContextService,
    private readonly config: ConfigService,
    private readonly tasks: BackgroundTaskTracker,
  ) {}

  @OnEvent(EvaluationCompletedEvent.eventName)
  handleEvaluationCompleted(event: EvaluationCompletedEvent): void {
    this.tasks.track(
      this.generate(event.evaluationId, event.model),
      `signalMentor.generate(${event.evaluationId})`,
    );
  }

  async generate(evaluationId: string, model?: string) {
    const evalRow = await this.evalRepo.findById(evaluationId);
    if (!evalRow) {
      throw new NotFoundException(`Evaluation ${evaluationId} not found`);
    }

    const session = await this.sessionReadService.getWithQuestion(evalRow.sessionId);
    const latestSnap = await this.snapshotsService.latest(evalRow.sessionId);
    const planMd =
      (latestSnap?.artifacts as { planMd?: string | null } | null)?.planMd ?? null;

    const phase = evalRow.phase as Phase;
    const rubric = await this.rubricLoader.load(
      session.question.rubricVersion,
      phase,
      session.question.kind ?? undefined,
      session.seniority ?? undefined,
    );
    const signalResults = evalRow.signalResults as unknown as Record<string, SignalResult>;
    const buildContext =
      phase === 'build' ? await this.buildContextSvc.load(evalRow.sessionId, session) : undefined;

    const ids = gapSignalIds(rubric, signalResults);

    if (ids.length === 0) {
      this.logger.log(
        `Signal-mentor for eval ${evaluationId}: no gap signals — persisting empty row.`,
      );
      const row = await this.repo.upsertByEvaluationId(evaluationId, {
        artifact: { annotations: {} },
        renderedPrompt: '',
        audit: {
          modelUsed: 'noop',
          tokensIn: 0,
          tokensOut: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 0,
        },
      });
      return SignalMentorRepository.toApiShape(row);
    }

    const signalById = new Map(rubric.signals.map((s) => [s.id, s]));
    const gaps: GapSignalContext[] = ids
      .map((id) => {
        const signal = signalById.get(id);
        const result = signalResults[id];
        if (!signal || !result) return null;
        return { signal, result };
      })
      .filter((g): g is GapSignalContext => g !== null);

    const input: SignalMentorInput = {
      userId: session.userId,
      question: session.question.prompt,
      planMd,
      gaps,
      feedbackText: evalRow.feedbackText,
      score: Number(evalRow.score),
      seniority: session.seniority ?? null,
      phase,
      buildContext,
      sessionId: evalRow.sessionId,
      evaluationId,
      ...(model ? { model } : {}),
    };

    let result: SignalMentorResult;
    try {
      result = await this.agent.generate(input);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Throw, don't swallow. Returning null here used to surface as
      // HTTP 200 + null body — callers polling for the annotation
      // artifact could not distinguish "still pending" from "agent
      // crashed," and every LLM API error / schema validation failure
      // / token limit breach was invisible to monitoring.
      this.logger.error(
        `Signal-mentor generation failed for evaluation ${evaluationId}: ${message}`,
        (err as Error).stack,
      );
      throw new InternalServerErrorException(
        `Signal-mentor generation failed for evaluation ${evaluationId}: ${message}`,
      );
    }

    const row = await this.repo.upsertByEvaluationId(evaluationId, result);

    await this.writeToDisk(evalRow.sessionId, evaluationId, result).catch((err) => {
      this.logger.warn(
        `Signal-mentor disk write failed for evaluation ${evaluationId}: ${(err as Error).message}`,
      );
    });

    return SignalMentorRepository.toApiShape(row);
  }

  async getByEvaluation(evaluationId: string) {
    const row = await this.repo.findByEvaluationId(evaluationId);
    if (!row) {
      throw new NotFoundException(
        `No signal-mentor artifact for evaluation ${evaluationId} — generate one first.`,
      );
    }
    return SignalMentorRepository.toApiShape(row);
  }

  private async writeToDisk(
    sessionId: string,
    evaluationId: string,
    result: SignalMentorResult,
  ): Promise<void> {
    const baseDir =
      this.config.get<string>('SIGNAL_MENTOR_ARTIFACT_DIR') ??
      './data/signal-mentor-artifacts';
    // sessionId originates from DB but writeToDisk is reachable from
    // arbitrary call paths; defend at the call site rather than rely
    // on upstream validation.
    const sessionDir = safeJoinUnderBase(baseDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptPath = safeJoinUnderBase(sessionDir, `${evaluationId}.${stamp}.prompt.txt`);
    const responsePath = safeJoinUnderBase(sessionDir, `${evaluationId}.${stamp}.response.json`);

    await Promise.all([
      fs.writeFile(promptPath, result.renderedPrompt, 'utf-8'),
      fs.writeFile(responsePath, JSON.stringify(result.artifact.annotations, null, 2), 'utf-8'),
    ]);

    this.logger.log(
      `Signal-mentor persisted to disk: ${promptPath} + ${responsePath}`,
    );
  }
}
