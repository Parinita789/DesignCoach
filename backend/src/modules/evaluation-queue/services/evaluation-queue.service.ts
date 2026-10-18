import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Job, Queue, Worker } from 'bullmq';
import { Phase } from '../../phase-tagger/types/phase.types';
import {
  EVALUATION_JOB_TYPES,
  EVALUATION_QUEUE_DEFAULT_JOB_OPTIONS,
  EvaluationJobType,
} from '../evaluation-queue.constants';
import {
  EvaluationArtifactJobData,
  EvaluationQueueJobData,
  PhaseEvaluationJobData,
} from '../types/evaluation-job.types';
import { EvaluationJobRepository } from '../repositories/evaluation-job.repository';

@Injectable()
export class EvaluationQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(EvaluationQueueService.name);
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<EvaluationJobType, Queue<EvaluationQueueJobData>>();
  private readonly workers: Array<Worker<EvaluationQueueJobData>> = [];

  constructor(
    private readonly config: ConfigService,
    private readonly jobs: EvaluationJobRepository,
  ) {
    this.connection = createRedisConnection(config);
  }

  async enqueuePlanScore(args: {
    sessionId: string;
    model?: string;
    fingerprint: string;
    resolvedModel: string;
  }): Promise<string> {
    const jobId = jobIdFor('eval-plan-score', [
      args.sessionId,
      args.resolvedModel,
      args.fingerprint,
    ]);
    return this.enqueuePhaseJob(EVALUATION_JOB_TYPES.planScore, jobId, {
      sessionId: args.sessionId,
      phase: 'plan',
      ...(args.model ? { model: args.model } : {}),
    });
  }

  async enqueueBuildEvaluation(args: {
    sessionId: string;
    model?: string;
    fingerprint: string;
    resolvedModel: string;
  }): Promise<string> {
    const jobId = jobIdFor('eval-build', [
      args.sessionId,
      args.resolvedModel,
      args.fingerprint,
    ]);
    return this.enqueuePhaseJob(EVALUATION_JOB_TYPES.buildEvaluation, jobId, {
      sessionId: args.sessionId,
      phase: 'build',
      ...(args.model ? { model: args.model } : {}),
    });
  }

  async enqueuePlanDetails(args: {
    sessionId: string;
    evaluationId: string;
    model?: string;
  }): Promise<string> {
    const jobId = jobIdFor('eval-plan-details', [args.evaluationId]);
    return this.enqueueArtifactJob(EVALUATION_JOB_TYPES.planDetails, jobId, args);
  }

  async enqueueMentor(args: {
    sessionId: string;
    evaluationId: string;
    model?: string;
  }): Promise<string> {
    const jobId = jobIdFor('mentor', [args.evaluationId]);
    return this.enqueueArtifactJob(EVALUATION_JOB_TYPES.mentor, jobId, args);
  }

  async enqueueSignalMentor(args: {
    sessionId: string;
    evaluationId: string;
    model?: string;
  }): Promise<string> {
    const jobId = jobIdFor('signal-mentor', [args.evaluationId]);
    return this.enqueueArtifactJob(EVALUATION_JOB_TYPES.signalMentor, jobId, args);
  }

  registerWorker(
    name: EvaluationJobType,
    processor: (job: Job<EvaluationQueueJobData>) => Promise<string | void>,
    concurrency: number,
  ): void {
    const worker = new Worker<EvaluationQueueJobData>(
      queueName(name),
      async (job) => {
        await this.jobs.markRunning(job.id!, job.attemptsMade + 1);
        return processor(job);
      },
      {
        connection: this.connection,
        concurrency,
      },
    );

    worker.on('completed', (job, evaluationId) => {
      this.jobs
        .markCompleted(job.id!, typeof evaluationId === 'string' ? evaluationId : undefined)
        .catch((err) =>
          this.logger.warn(`Failed to mark job ${job.id} completed: ${err.message}`),
        );
    });
    worker.on('failed', (job, err) => {
      if (!job) return;
      job
        .getState()
        .then((state) =>
          willRetry(state)
            ? this.jobs.markRetrying(job.id!, job.attemptsMade, err.message)
            : this.jobs.markFailed(job.id!, job.attemptsMade, err.message),
        )
        .catch((writeErr) =>
          this.logger.warn(`Failed to record failure for job ${job.id}: ${writeErr.message}`),
        );
    });
    worker.on('error', (err) => {
      this.logger.error(`BullMQ worker error (${name}): ${err.message}`, err.stack);
    });

    this.workers.push(worker);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private async enqueuePhaseJob(
    type: EvaluationJobType,
    jobId: string,
    data: PhaseEvaluationJobData,
  ): Promise<string> {
    try {
      const queue = this.queueFor(type);
      if (await this.existingJobStillActive(queue, jobId, { rerunCompleted: true })) {
        return jobId;
      }
      await this.jobs.upsertQueued({
        id: jobId,
        jobType: type,
        sessionId: data.sessionId,
        phase: data.phase as Phase,
      });
      const job = await queue.add(type, data, { jobId });
      return job.id!;
    } catch (err) {
      if (isDuplicateJobError(err)) return jobId;
      await this.jobs.markFailed(jobId, 0, errorMessage(err)).catch(() => undefined);
      this.logger.error(`Failed to enqueue ${type} job ${jobId}: ${errorMessage(err)}`);
      throw new ServiceUnavailableException('Evaluation queue is unavailable');
    }
  }

  private async enqueueArtifactJob(
    type: EvaluationJobType,
    jobId: string,
    data: EvaluationArtifactJobData,
  ): Promise<string> {
    try {
      const queue = this.queueFor(type);
      if (await this.existingJobStillActive(queue, jobId, { rerunCompleted: false })) {
        return jobId;
      }
      await this.jobs.upsertQueued({
        id: jobId,
        jobType: type,
        sessionId: data.sessionId,
        evaluationId: data.evaluationId,
      });
      const job = await queue.add(type, data, { jobId });
      return job.id!;
    } catch (err) {
      if (isDuplicateJobError(err)) return jobId;
      await this.jobs.markFailed(jobId, 0, errorMessage(err)).catch(() => undefined);
      this.logger.error(`Failed to enqueue ${type} job ${jobId}: ${errorMessage(err)}`);
      throw new ServiceUnavailableException('Evaluation queue is unavailable');
    }
  }

  private queueFor(type: EvaluationJobType): Queue<EvaluationQueueJobData> {
    const existing = this.queues.get(type);
    if (existing) return existing;
    const queue: Queue<EvaluationQueueJobData> = new Queue<EvaluationQueueJobData>(
      queueName(type),
      {
      connection: this.connection,
      defaultJobOptions: EVALUATION_QUEUE_DEFAULT_JOB_OPTIONS,
      },
    );
    this.queues.set(type, queue);
    return queue;
  }

  private async existingJobStillActive(
    queue: Queue<EvaluationQueueJobData>,
    jobId: string,
    options: { rerunCompleted: boolean },
  ): Promise<boolean> {
    const existing = await queue.getJob(jobId);
    if (!existing) return false;
    const state = await existing.getState();
    if (shouldRemoveExistingJob(state, options.rerunCompleted)) {
      await existing.remove();
      return false;
    }
    return true;
  }
}

export function queueName(type: EvaluationJobType): string {
  return `evaluation-work-${type}`;
}

export function jobIdFor(prefix: string, parts: string[]): string {
  return [prefix, ...parts].map((part) => part.replace(/:/g, '_')).join('__');
}

// BullMQ emits the worker 'failed' event after every failed attempt,
// including ones it is about to retry, so the event alone doesn't mean
// the job is dead. Read the job's state instead of comparing
// attemptsMade to opts.attempts: a job that exceeds the stalled limit
// (e.g. its lock lapsed while the host slept) is failed outright with
// attempts remaining.
export function willRetry(state: string): boolean {
  return state !== 'failed';
}

export function shouldRemoveExistingJob(
  state: string,
  rerunCompleted: boolean,
): boolean {
  return state === 'failed' || (rerunCompleted && state === 'completed');
}

function createRedisConnection(config: ConfigService): ConnectionOptions {
  const url = config.get<string>('REDIS_URL');
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
    };
  }
  return {
    host: config.get<string>('REDIS_HOST') ?? '127.0.0.1',
    port: Number(config.get<string>('REDIS_PORT') ?? 6379),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    maxRetriesPerRequest: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDuplicateJobError(err: unknown): boolean {
  return /already exists|duplicated job/i.test(errorMessage(err));
}
