import { EVALUATION_JOB_TYPES } from '../evaluation-queue.constants';
import {
  jobIdFor,
  queueName,
  shouldRemoveExistingJob,
  willRetry,
} from './evaluation-queue.service';

describe('EvaluationQueueService identifiers', () => {
  it('uses BullMQ-safe queue names and custom job ids', () => {
    const name = queueName(EVALUATION_JOB_TYPES.planScore);
    const jobId = jobIdFor('eval-plan-score', [
      '00000000-0000-0000-0000-000000000001',
      'claude:sonnet:test',
      'abc123',
    ]);

    expect(name).toBe('evaluation-work-plan-score');
    expect(name).not.toContain(':');
    expect(jobId).toBe(
      'eval-plan-score__00000000-0000-0000-0000-000000000001__claude_sonnet_test__abc123',
    );
    expect(jobId).not.toContain(':');
  });
});

describe('EvaluationQueueService duplicate handling', () => {
  it('re-enqueues completed phase jobs so cache-hit downstream repair can run', async () => {
    expect(shouldRemoveExistingJob('completed', true)).toBe(true);
  });

  it('keeps completed artifact jobs deduped', async () => {
    expect(shouldRemoveExistingJob('completed', false)).toBe(false);
  });

  it('always removes failed jobs before re-enqueue', async () => {
    expect(shouldRemoveExistingJob('failed', true)).toBe(true);
    expect(shouldRemoveExistingJob('failed', false)).toBe(true);
  });
});

describe('EvaluationQueueService retry detection', () => {
  it('treats a failed attempt with attempts remaining as a pending retry', () => {
    expect(willRetry(1, 3)).toBe(true);
    expect(willRetry(2, 3)).toBe(true);
  });

  it('treats the last attempt as a terminal failure', () => {
    expect(willRetry(3, 3)).toBe(false);
  });

  it('treats a job without an attempts option as single-attempt', () => {
    expect(willRetry(1, undefined)).toBe(false);
  });
});
