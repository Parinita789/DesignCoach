import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { PhaseEvaluation, Session, SessionStatus } from '@prisma/client';
import { SessionsRepository } from '../repositories/sessions.repository';
import { EndSessionDto } from '../dto/end-session.dto';
import { EvaluationsService } from '../../evaluations/services/evaluations.service';

// buildTokenHash is intentionally stripped at the repository — it
// must never reach the API. The service surfaces the redacted shape.
export type RedactedSession = Omit<Session, 'buildTokenHash'>;

export interface EndSessionResult {
  session: RedactedSession;
  evaluations: PhaseEvaluation[];
  evalError: string | null;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly sessionsRepository: SessionsRepository,
    @Inject(forwardRef(() => EvaluationsService))
    private readonly evaluationsService: EvaluationsService,
  ) {}

  async get(sessionId: string) {
    const session = await this.sessionsRepository.findById(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }

  async getWithQuestion(sessionId: string) {
    const session = await this.sessionsRepository.findByIdWithQuestion(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }

  list() {
    return this.sessionsRepository.findAll();
  }

  async end(sessionId: string, dto: EndSessionDto): Promise<EndSessionResult> {
    const existing = await this.sessionsRepository.findById(sessionId);
    if (!existing) throw new NotFoundException(`Session ${sessionId} not found`);
    const status = dto.status ?? SessionStatus.completed;
    const ended = await this.sessionsRepository.markEnded(sessionId, status);

    // Only auto-evaluate when the session completes naturally. Cancelled
    // (abandoned) sessions skip evaluation entirely.
    if (status !== SessionStatus.completed) {
      return { session: ended, evaluations: [], evalError: null };
    }

    try {
      const evaluations = await this.evaluationsService.runForSession(sessionId);
      return { session: ended, evaluations, evalError: null };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`Evaluation failed for ${sessionId}: ${message}`);
      // Session stays `completed` — losing the evaluation shouldn't hold the
      // session hostage. Frontend will surface the error and offer a retry.
      return { session: ended, evaluations: [], evalError: message };
    }
  }
}
