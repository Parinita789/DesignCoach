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
import { SessionReadService } from '../../session-read/services/session-read.service';
import { SnapshotsService } from '../../snapshots/services/snapshots.service';
import { BuildContextService } from '../../evaluations/services/build-context.service';
import { SignalResult } from '../../evaluations/types/evaluation.types';
import { Phase } from '../../phase-tagger/types/phase.types';
import { MentorAgent } from '../agents/mentor.agent';
import { MentorRepository } from '../repositories/mentor.repository';
import { CrossPhaseSummary, MentorInput, MentorResult } from '../types/mentor.types';

@Injectable()
export class MentorService {
  private readonly logger = new Logger(MentorService.name);

  constructor(
    private readonly mentorAgent: MentorAgent,
    private readonly mentorRepo: MentorRepository,
    private readonly evalRepo: EvaluationsRepository,
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
      `mentor.generate(${event.evaluationId})`,
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
    const buildContext =
      phase === 'build' ? await this.buildContextSvc.load(evalRow.sessionId, session) : undefined;
    const crossPhase = await this.loadCrossPhaseSummary(evalRow.sessionId, evaluationId, phase);

    const input: MentorInput = {
      userId: session.userId,
      question: session.question.prompt,
      planMd,
      signalResults: evalRow.signalResults as unknown as Record<string, SignalResult>,
      feedbackText: evalRow.feedbackText,
      topActionableItems: (evalRow.topActionableItems as unknown as string[]) ?? [],
      score: Number(evalRow.score),
      seniority: session.seniority ?? null,
      phase,
      buildContext,
      crossPhase,
      sessionId: evalRow.sessionId,
      evaluationId,
      ...(model ? { model } : {}),
    };

    let result: MentorResult;
    try {
      result = await this.mentorAgent.generate(input);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Throw, don't swallow. Returning null here used to surface
      // as HTTP 200 + null body — callers polling for an artifact
      // could not distinguish "still pending" from "agent crashed,"
      // and every LLM API error / schema validation failure / token
      // limit breach was invisible to monitoring.
      this.logger.error(
        `Mentor generation failed for evaluation ${evaluationId}: ${message}`,
        (err as Error).stack,
      );
      throw new InternalServerErrorException(
        `Mentor generation failed for evaluation ${evaluationId}: ${message}`,
      );
    }

    const row = await this.mentorRepo.upsertByEvaluationId(evaluationId, result);

    await this.writeToDisk(evalRow.sessionId, evaluationId, result).catch((err) => {
      this.logger.warn(
        `Mentor disk write failed for evaluation ${evaluationId}: ${(err as Error).message}`,
      );
    });

    return MentorRepository.toApiShape(row);
  }

  async getByEvaluation(evaluationId: string) {
    const row = await this.mentorRepo.findByEvaluationId(evaluationId);
    if (!row) {
      throw new NotFoundException(
        `No mentor artifact for evaluation ${evaluationId} — generate one first.`,
      );
    }
    return MentorRepository.toApiShape(row);
  }

  private async writeToDisk(
    sessionId: string,
    evaluationId: string,
    result: MentorResult,
  ): Promise<void> {
    const baseDir =
      this.config.get<string>('MENTOR_ARTIFACT_DIR') ?? './data/mentor-artifacts';
    // sessionId comes from the DB but `writeToDisk` is reachable from
    // any caller path; defend at the call site rather than assume the
    // upstream validated.
    const sessionDir = safeJoinUnderBase(baseDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptPath = safeJoinUnderBase(sessionDir, `${evaluationId}.${stamp}.prompt.txt`);
    const responsePath = safeJoinUnderBase(sessionDir, `${evaluationId}.${stamp}.response.md`);

    await Promise.all([
      fs.writeFile(promptPath, result.renderedPrompt, 'utf-8'),
      fs.writeFile(responsePath, result.artifact.content, 'utf-8'),
    ]);

    this.logger.log(
      `Mentor artifact persisted to disk: ${promptPath} + ${responsePath}`,
    );
  }

  private async loadCrossPhaseSummary(
    sessionId: string,
    selfEvaluationId: string,
    selfPhase: Phase,
  ): Promise<CrossPhaseSummary | undefined> {
    const otherPhase: Phase = selfPhase === 'plan' ? 'build' : 'plan';
    const all = await this.evalRepo.findBySession(sessionId);
    const other = all.find((e) => e.phase === otherPhase && e.id !== selfEvaluationId);
    if (!other) return undefined;

    const signals = (other.signalResults ?? {}) as unknown as Record<string, SignalResult>;
    const fired: CrossPhaseSummary['topSignalsFired'] = [];
    for (const [id, sig] of Object.entries(signals)) {
      if (sig.result === 'hit' || sig.result === 'partial') {
        fired.push({
          id,
          polarity: 'good',
          result: sig.result,
          evidence: sig.evidence ?? '',
        });
      }
    }
    const slim = fired.slice(0, 5);

    return {
      phase: otherPhase,
      score: Number(other.score),
      feedbackText: other.feedbackText ?? '',
      topSignalsFired: slim,
    };
  }
}
