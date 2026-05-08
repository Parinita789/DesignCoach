import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Question, Session } from '@prisma/client';
import { QuestionsRepository } from '../repositories/questions.repository';
import { SessionsRepository } from '../../sessions/repositories/sessions.repository';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SnapshotsService } from '../../snapshots/services/snapshots.service';
import { CreateQuestionDto } from '../dto/create-question.dto';
import { classifyKind } from '../../evaluations/helpers/kind-classifier';
import { Seniority as PrismaSeniority } from '@prisma/client';
import { BackgroundTaskTracker } from '../../../common/background-task-tracker.service';

@Injectable()
export class QuestionsService {
  private readonly logger = new Logger(QuestionsService.name);

  constructor(
    private readonly questionsRepository: QuestionsRepository,
    private readonly sessionsRepository: SessionsRepository,
    private readonly sessionsService: SessionsService,
    private readonly snapshotsService: SnapshotsService,
    private readonly config: ConfigService,
    private readonly tasks: BackgroundTaskTracker,
  ) {}

  async create(dto: CreateQuestionDto): Promise<{ question: Question; session: Session }> {
    const rubricVersion = this.config.get<string>('RUBRIC_VERSION') ?? 'v3.0';
    const kind = dto.kind ?? classifyKind(dto.prompt);
    const seniority: PrismaSeniority = dto.seniority ?? 'senior';
    const question = await this.questionsRepository.create({
      prompt: dto.prompt,
      rubricVersion,
      kind,
    });
    const session = await this.sessionsRepository.create({
      questionId: question.id,
      seniority,
    });
    return { question, session };
  }

  list() {
    return this.questionsRepository.findAll();
  }

  async get(questionId: string) {
    const question = await this.questionsRepository.findById(questionId);
    if (!question) throw new NotFoundException(`Question ${questionId} not found`);
    return question;
  }

  async startAttempt(questionId: string, seniorityOverride?: PrismaSeniority): Promise<Session> {
    const question = await this.get(questionId);

    let inheritedPlanMd: string | null = null;
    let mostRecent: Date | null = null;
    let inheritedSeniority: PrismaSeniority | null = null;
    let mostRecentSession: Date | null = null;
    for (const s of question.sessions) {
      if (!mostRecentSession || s.startedAt > mostRecentSession) {
        mostRecentSession = s.startedAt;
        inheritedSeniority = s.seniority ?? null;
      }
      const snap = await this.snapshotsService.latest(s.id);
      if (!snap) continue;
      const planMd = (snap.artifacts as { planMd?: string | null } | null)?.planMd ?? null;
      if (planMd && (!mostRecent || snap.takenAt > mostRecent)) {
        inheritedPlanMd = planMd;
        mostRecent = snap.takenAt;
      }
    }

    const seniority = seniorityOverride ?? inheritedSeniority;

    const session = await this.sessionsRepository.create({
      questionId,
      seniority,
    });

    if (inheritedPlanMd && inheritedPlanMd.trim().length > 0) {
      await this.snapshotsService.capture(session.id, {
        elapsedMinutes: 0,
        artifacts: { planMd: inheritedPlanMd },
      });
    }

    this.logger.log(
      `Started attempt ${session.id} for question ${questionId} ` +
        `(inherited ${inheritedPlanMd?.length ?? 0} chars of plan.md, seniority=${seniority ?? 'null'})`,
    );
    return session;
  }

  async deleteQuestion(
    questionId: string,
  ): Promise<{ ok: true; deletedSessions: number }> {
    const question = await this.questionsRepository.findById(questionId);
    if (!question) throw new NotFoundException(`Question ${questionId} not found`);
    const deletedIds = await this.questionsRepository.deleteByIdCascading(questionId);
    this.logger.log(
      `Question ${questionId} deleted (${deletedIds.length} attempt(s) cascaded). ` +
        'Scheduling per-session disk cleanup.',
    );
    for (const sid of deletedIds) {
      this.tasks.track(
        this.sessionsService.cleanupArtifacts(sid),
        `cleanupArtifacts(${sid})`,
      );
    }
    return { ok: true, deletedSessions: deletedIds.length };
  }
}
