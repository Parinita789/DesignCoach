import { Fragment, RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionsService } from '@/services/sessions.service';
import { questionsService } from '@/services/questions.service';
import { DAILY_SPEND_QUERY_KEY } from '@components/layout/DailySpendBadge';
import { snapshotsService } from '@/services/snapshots.service';
import { evaluationsService } from '@/services/evaluations.service';
import { rubricsService } from '@/services/rubrics.service';
import { useSessionStore } from '@/store/sessionStore';
import { ScoreBreakdown } from '@/components/ScoreBreakdown';
import {
  EvaluationAudit,
  EvaluationJobStatus,
  GapTopic,
  PhaseEvaluation,
  SignalResult,
} from '@/types/evaluation';
import { Rubric, RubricSignal, WeightTier } from '@/types/rubric';
import { QuestionKind, QuestionWithSessions, SENIORITIES, Seniority } from '@/types/question';
import { computeCostUsd, formatCostUsd, formatLatency } from '@/lib/llm-cost';
import { mentorService } from '@/services/mentor.service';
import { signalMentorService } from '@/services/signalMentor.service';
import { MentorArtifactView } from '@/components/MentorArtifactView';
import { MarkdownView } from '@/components/MarkdownView';
import { BuildPhaseSection } from '@/components/BuildPhaseSection';
import { extractApiError } from '@/lib/error';

type ResultKind = SignalResult['result'] | 'not_evaluated';

const RESULT_STYLES: Record<ResultKind, { label: string; className: string }> = {
  hit: { label: 'HIT', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  partial: { label: 'PARTIAL', className: 'bg-amber-100 text-amber-800 border-amber-300' },
  miss: { label: 'MISS', className: 'bg-gray-100 text-gray-700 border-gray-300' },
  cannot_evaluate: {
    label: 'N/A',
    className: 'bg-gray-50 text-gray-500 border-gray-200',
  },
  not_evaluated: {
    label: 'NOT EVALUATED',
    className: 'bg-purple-50 text-purple-700 border-purple-200',
  },
};

const WEIGHT_STYLES: Record<WeightTier, string> = {
  high: 'bg-rose-50 text-rose-700 border-rose-200',
  medium: 'bg-teal-50 text-teal-700 border-teal-200',
  low: 'bg-gray-50 text-gray-600 border-gray-200',
};

function formatScore(score: number | string): string {
  const n = typeof score === 'string' ? parseFloat(score) : score;
  return Number.isFinite(n) ? n.toFixed(2) : String(score);
}

function useOutsideClickToClose(
  ref: RefObject<HTMLElement>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, active, onClose]);
}

function formatModelName(model: string | null | undefined): string {
  if (!model) return '—';
  const m = model.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!m) return model;
  const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${tier} ${m[2]}.${m[3]}`;
}

function formatJobType(jobType: string): string {
  return jobType
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function scoreVerdict(score: number | string): { label: string; className: string } {
  const n = typeof score === 'string' ? parseFloat(score) : score;
  if (!Number.isFinite(n)) {
    return { label: '—', className: 'bg-gray-100 text-gray-600 border-gray-300' };
  }
  if (n < 3) return { label: 'Failed', className: 'bg-rose-100 text-rose-800 border-rose-300' };
  if (n < 4) return { label: 'Average', className: 'bg-amber-100 text-amber-800 border-amber-300' };
  if (n < 5) return { label: 'Good', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' };
  return { label: 'Great', className: 'bg-emerald-200 text-emerald-900 border-emerald-400' };
}

export function SessionResultsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActive = useSessionStore((s) => s.setActive);
  const forgetSession = useSessionStore((s) => s.forget);
  const [planMdExpanded, setPlanMdExpanded] = useState(false);
  const [attemptsOpen, setAttemptsOpen] = useState(false);
  const [selectedEvalId, setSelectedEvalId] = useState<string | null>(null);
  const [queuedEvalSince, setQueuedEvalSince] = useState<number | null>(null);

  const sessionQuery = useQuery({
    queryKey: ['session', id],
    queryFn: () => sessionsService.get(id!),
    enabled: !!id,
  });

  const evalsQuery = useQuery({
    queryKey: ['evals', id],
    queryFn: () => evaluationsService.listForSession(id!),
    enabled: !!id,
    // Two-call plan eval polling: when the most-recent plan eval row
    // has neither detailsCompletedAt nor detailsError, Call B is still
    // in flight. Poll every 3s until one of them lands. Build rows
    // (and any pre-migration plan rows where both are null because
    // they predate the split) won't ever flip — so we only poll if
    // the row was created recently. Without that guard, every old
    // session loaded in the UI would poll forever.
    refetchInterval: (q) => {
      const rows = (q.state.data as PhaseEvaluation[] | undefined) ?? [];
      const newestEval = [...rows].sort((a, b) =>
        a.evaluatedAt < b.evaluatedAt ? 1 : -1,
      )[0];
      if (
        queuedEvalSince &&
        (!newestEval || new Date(newestEval.evaluatedAt).getTime() < queuedEvalSince)
      ) {
        return Date.now() - queuedEvalSince < 5 * 60 * 1000 ? 3000 : false;
      }
      const endedAt = sessionQuery.data?.endedAt;
      if (!rows.length && endedAt) {
        const endedAgeMs = Date.now() - new Date(endedAt).getTime();
        if (endedAgeMs < 5 * 60 * 1000) return 3000;
      }
      const latestPlan = rows
        .filter((r) => r.phase === 'plan')
        .sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1))[0];
      if (!latestPlan) return false;
      if (latestPlan.detailsCompletedAt) return false;
      if (latestPlan.detailsError) {
        // Read the jobs cache rather than evaluationJobsQuery: that
        // hook is declared below, so the closure can't reference it.
        // A failed Call B attempt writes detailsError, but the job may
        // still be retrying, and a later success clears the error.
        const jobs =
          queryClient.getQueryData<EvaluationJobStatus[]>(['evaluation-jobs', id]) ?? [];
        const detailsRetrying = jobs.some(
          (job) =>
            job.jobType === 'plan-details' &&
            job.evaluationId === latestPlan.id &&
            (job.state === 'queued' || job.state === 'running'),
        );
        return detailsRetrying ? 3000 : false;
      }
      // Only poll for "recent" rows — i.e., where the row is younger
      // than the 5min reasonable upper bound on Call B latency. An
      // older row with both nulls is a legacy pre-split row and will
      // never get patched.
      const ageMs = Date.now() - new Date(latestPlan.evaluatedAt).getTime();
      if (ageMs > 5 * 60 * 1000) return false;
      return 3000;
    },
  });

  const evaluationJobsQuery = useQuery({
    queryKey: ['evaluation-jobs', id],
    queryFn: () => evaluationsService.listJobsForSession(id!),
    enabled: !!id,
    refetchInterval: (q) => {
      const rows = (q.state.data as EvaluationJobStatus[] | undefined) ?? [];
      return rows.some((job) => job.state === 'queued' || job.state === 'running')
        ? 3000
        : false;
    },
  });

  const snapshotQuery = useQuery({
    queryKey: ['snapshot-latest', id],
    queryFn: () => snapshotsService.latest(id!),
    enabled: !!id,
  });

  const questionId = sessionQuery.data?.questionId;
  const rubricVersion = sessionQuery.data?.question.rubricVersion;
  const rubricKind = sessionQuery.data?.question.kind ?? null;
  const rubricSeniority = sessionQuery.data?.seniority ?? null;
  const isAgenticBuild = rubricKind === 'agentic_build';
  const rubricQuery = useQuery({
    queryKey: ['rubric', rubricVersion, 'plan', rubricKind, rubricSeniority],
    queryFn: () =>
      rubricsService.get(rubricVersion!, 'plan', rubricKind, rubricSeniority),
    enabled: !!rubricVersion,
  });

  const buildRubricQuery = useQuery({
    queryKey: ['rubric', rubricVersion, 'build', rubricKind, rubricSeniority],
    queryFn: () =>
      rubricsService.get(rubricVersion!, 'build', rubricKind, rubricSeniority),
    enabled: !!rubricVersion && isAgenticBuild,
  });

  const questionQuery = useQuery({
    queryKey: ['question', questionId],
    queryFn: () => questionsService.get(questionId!),
    enabled: !!questionId,
  });

  const reEvalMutation = useMutation({
    mutationFn: (model?: string) => evaluationsService.runForSession(id!, model),
    onSuccess: () => {
      setQueuedEvalSince(Date.now());
      setSelectedEvalId(null);
      queryClient.invalidateQueries({ queryKey: ['evals', id] });
      queryClient.invalidateQueries({ queryKey: ['evaluation-jobs', id] });
      queryClient.invalidateQueries({ queryKey: ['question', questionId] });
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      queryClient.invalidateQueries({ queryKey: DAILY_SPEND_QUERY_KEY });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (seniority?: Seniority) =>
      questionsService.startAttempt(questionId!, seniority),
    onSuccess: (newSession) => {
      setActive(newSession.id, newSession.startedAt);
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      queryClient.invalidateQueries({ queryKey: ['question', questionId] });
      navigate(`/sessions/${newSession.id}/active`);
    },
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => sessionsService.delete(id!),
    onSuccess: () => {
      setDeleteOpen(false);
      if (id) forgetSession(id);

      const siblings = (questionQuery.data?.sessions ?? []).filter((s) => s.id !== id);
      const byStartedDesc = (a: { startedAt: string }, b: { startedAt: string }) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
      const nextCompleted = [...siblings]
        .filter((s) => s.status === 'completed')
        .sort(byStartedDesc)[0];
      const nextAny = nextCompleted ?? [...siblings].sort(byStartedDesc)[0];

      if (nextAny) {
        navigate(`/sessions/${nextAny.id}`);
      } else {
        navigate(questionId ? `/questions/${questionId}` : '/');
      }

      queryClient.removeQueries({ queryKey: ['session', id] });
      queryClient.removeQueries({ queryKey: ['evals', id] });
      queryClient.removeQueries({ queryKey: ['snapshot', id] });
      queryClient.removeQueries({ queryKey: ['build-events', id] });
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      queryClient.invalidateQueries({ queryKey: ['question', questionId] });
    },
  });

  const planEvals = useMemo<PhaseEvaluation[]>(
    () => (evalsQuery.data ?? []).filter((e) => e.phase === 'plan'),
    [evalsQuery.data],
  );
  const buildEvals = useMemo<PhaseEvaluation[]>(
    () => (evalsQuery.data ?? []).filter((e) => e.phase === 'build'),
    [evalsQuery.data],
  );
  const displayedEval = useMemo<PhaseEvaluation | undefined>(() => {
    if (selectedEvalId) {
      const pinned = planEvals.find((e) => e.id === selectedEvalId);
      if (pinned) return pinned;
    }
    return planEvals[0];
  }, [planEvals, selectedEvalId]);
  const isLatestDisplayed = displayedEval?.id === planEvals[0]?.id;
  const latestEvaluationJob = useMemo(() => {
    const jobs = evaluationJobsQuery.data ?? [];
    return jobs.find((job) =>
      ['plan-score', 'build-evaluation'].includes(job.jobType),
    );
  }, [evaluationJobsQuery.data]);
  const latestJobIsNewerThanEval =
    !!latestEvaluationJob &&
    (!displayedEval ||
      new Date(displayedEval.evaluatedAt).getTime() <
        new Date(latestEvaluationJob.updatedAt).getTime());
  const queuedEvaluationJob =
    latestJobIsNewerThanEval &&
    latestEvaluationJob &&
    (latestEvaluationJob.state === 'queued' || latestEvaluationJob.state === 'running')
      ? latestEvaluationJob
      : null;
  const failedEvaluationJob =
    latestJobIsNewerThanEval && latestEvaluationJob?.state === 'failed'
      ? latestEvaluationJob
      : null;

  if (!id) return <div>Missing session id.</div>;
  if (deleteMutation.isPending || deleteMutation.isSuccess) {
    return <div className="text-gray-500">Deleting session…</div>;
  }
  if (sessionQuery.isPending || evalsQuery.isPending) return <div>Loading…</div>;
  if (sessionQuery.isError) {
    return (
      <div className="text-red-600">
        Failed to load session: {extractApiError(sessionQuery.error)}
      </div>
    );
  }

  const session = sessionQuery.data;
  const planMd =
    (snapshotQuery.data?.artifacts as { planMd?: string | null } | null)?.planMd ?? null;
  const displayedScore = displayedEval?.score ?? session.overallScore;
  const displayedVerdict =
    displayedScore === null || displayedScore === undefined
      ? null
      : scoreVerdict(displayedScore);
  const scorePercent =
    displayedScore === null || displayedScore === undefined
      ? 0
      : Math.max(0, Math.min(100, (Number(displayedScore) / 5) * 100));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-lg border border-teal-100 bg-teal-50/70 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <Link
          to={questionId ? `/questions/${questionId}` : '/home'}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:text-teal-900"
        >
          <span aria-hidden="true">←</span>
          Back to question
        </Link>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <RetryButton
            currentSeniority={session.seniority ?? null}
            isPending={retryMutation.isPending}
            disabled={!questionId}
            onRetry={(seniority) => retryMutation.mutate(seniority)}
          />
          <ReEvaluateButton
            isPending={reEvalMutation.isPending}
            onRun={(model) => reEvalMutation.mutate(model)}
          />
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteMutation.isPending}
            className="rounded border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Delete this attempt only (the question and other attempts stay). To delete the whole question, use the trash icon in the sidebar."
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete attempt'}
          </button>
        </div>
      </div>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="bg-gradient-to-r from-gray-950 via-slate-800 to-teal-900 px-5 py-5 text-white">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="max-w-4xl whitespace-pre-wrap text-base font-medium leading-7 text-teal-50">
              {session.question.prompt}
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 font-medium capitalize text-teal-100">
                {session.status}
              </span>
              {session.seniority && (
                <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 font-medium capitalize text-teal-100">
                  {session.seniority}
                </span>
              )}
              <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 font-medium text-teal-100">
                {evalsQuery.data?.length ?? 0} eval{(evalsQuery.data?.length ?? 0) === 1 ? '' : 's'}
              </span>
              <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 font-medium text-teal-100">
                {planMd ? planMd.length : 0} plan chars
              </span>
              {session.endedAt && (
                <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 font-medium text-teal-100">
                  ended {new Date(session.endedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div className="w-full shrink-0 rounded-lg bg-white/10 px-4 py-3 ring-1 ring-white/15 sm:w-48">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium uppercase tracking-wide text-teal-100">
                Score
              </div>
              {displayedVerdict && (
                <span
                  className={`inline-block rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${displayedVerdict.className}`}
                >
                  {displayedVerdict.label}
                </span>
              )}
            </div>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-4xl font-semibold leading-none tabular-nums">
                {displayedScore === null || displayedScore === undefined
                  ? '—'
                  : formatScore(displayedScore)}
              </span>
              <span className="pb-1 text-sm text-teal-100">/ 5</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-300 to-emerald-300"
                style={{ width: `${scorePercent}%` }}
              />
            </div>
          </div>
          </div>
        </div>
      </section>

      {retryMutation.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn't start a new attempt: {extractApiError(retryMutation.error)}
        </div>
      )}

      {reEvalMutation.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Re-evaluation failed: {extractApiError(reEvalMutation.error)}
        </div>
      )}

      {queuedEvaluationJob && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          {formatJobType(queuedEvaluationJob.jobType)} is {queuedEvaluationJob.state}.
          The result will appear here automatically.
        </div>
      )}

      {failedEvaluationJob && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {formatJobType(failedEvaluationJob.jobType)} failed after{' '}
          {failedEvaluationJob.attempts || 1} attempt
          {(failedEvaluationJob.attempts || 1) === 1 ? '' : 's'}:{' '}
          {failedEvaluationJob.lastError ?? 'No error message was recorded.'}
        </div>
      )}

      {(questionQuery.data?.sessions.length ?? 0) > 0 && (
        <CollapsibleSection
          label="Attempts of this question"
          subtitle="Different attempts of this question — each has its own plan.md"
          count={questionQuery.data?.sessions.length ?? 0}
          rubricVersion={formatRubricTag(
            session.question.rubricVersion,
            session.question.kind,
            session.seniority,
          )}
          open={attemptsOpen}
          onToggle={() => setAttemptsOpen((v) => !v)}
        >
          <AttemptsSection
            currentSessionId={session.id}
            attempts={questionQuery.data?.sessions ?? []}
            loading={questionQuery.isPending}
            selectedEvalId={displayedEval?.id ?? null}
            onSelectEval={setSelectedEvalId}
          />
        </CollapsibleSection>
      )}

      {!displayedEval ? (
        session.status === 'abandoned' ? (
          <CancelledEmptyState
            siblings={questionQuery.data?.sessions ?? []}
            currentSessionId={session.id}
          />
        ) : (
          <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Not yet evaluated. Click <strong>Re-evaluate</strong> to score this session.
          </div>
        )
      ) : (
        <PlanEvaluationView
          evaluation={displayedEval}
          rubric={rubricQuery.data}
          isLatest={isLatestDisplayed}
          onShowLatest={() => setSelectedEvalId(null)}
        />
      )}

      {session.status === 'completed' && isAgenticBuild && <BuildPhaseSection session={session} />}

      {session.status === 'completed' && isAgenticBuild && buildEvals[0] && (
        <section>
          <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-2">
            Build evaluation
          </h3>
          <PlanEvaluationView
            evaluation={buildEvals[0]}
            rubric={buildRubricQuery.data}
            isLatest={true}
            onShowLatest={() => undefined}
            phaseLabel="Build"
          />
        </section>
      )}

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => setPlanMdExpanded((v) => !v)}
          className="flex w-full items-center justify-between border-b border-gray-100 bg-gray-50/80 px-4 py-3 text-left text-sm font-semibold text-gray-950 hover:bg-gray-50"
        >
          <span className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-100 text-teal-700">
              {planMdExpanded ? '⌄' : '›'}
            </span>
            plan.md
          </span>
          <span className="text-xs font-medium text-gray-500">
            {planMd ? planMd.length : 0} chars
          </span>
        </button>
        {planMdExpanded && (
          <div className="overflow-x-auto p-4">
            {planMd ? (
              <MarkdownView markdown={planMd} />
            ) : (
              <span className="text-xs text-gray-500 italic">
                (no plan content captured)
              </span>
            )}
          </div>
        )}
      </section>

      {deleteOpen && (
        <ConfirmDeleteSessionDialog
          onConfirm={() => deleteMutation.mutate()}
          onDismiss={() => setDeleteOpen(false)}
          isPending={deleteMutation.isPending}
          error={
            deleteMutation.isError ? extractApiError(deleteMutation.error) : null
          }
        />
      )}

    </div>
  );
}

function ConfirmDeleteSessionDialog({
  onConfirm,
  onDismiss,
  isPending,
  error,
}: {
  onConfirm: () => void;
  onDismiss: () => void;
  isPending: boolean;
  error: string | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPending) return;
      if (e.key === 'Escape') onDismiss();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onDismiss, isPending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={isPending ? undefined : onDismiss}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold text-gray-900">
            Delete this session?
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            The session row, every plan.md snapshot, the build event log,
            captured Claude Code turns, plan + build evaluations, and the
            mentor + signal-mentor artifacts tied to this session will be
            removed. This is not reversible.
          </p>
          <p className="mt-2 text-[11px] text-gray-500">
            On-disk prompt + response files are cleaned up in the background;
            the page will navigate away as soon as the database row is gone.
          </p>
        </div>
        {error && (
          <div className="mx-5 mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
            Couldn't delete: {error}
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 py-3 bg-gray-50 rounded-b-lg">
          <button
            type="button"
            onClick={onDismiss}
            disabled={isPending}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            disabled={isPending}
            className="rounded bg-rose-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Deleting…' : 'Delete session'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanEvaluationView({
  evaluation,
  rubric,
  isLatest,
  onShowLatest,
  phaseLabel = 'Plan',
  signalMentorEnabled = true,
}: {
  evaluation: PhaseEvaluation;
  rubric: Rubric | undefined;
  isLatest: boolean;
  onShowLatest: () => void;
  phaseLabel?: string;
  signalMentorEnabled?: boolean;
}) {
  const goodSignals = rubric?.signals.filter((s) => s.polarity === 'good') ?? [];
  const badSignals = rubric?.signals.filter((s) => s.polarity === 'bad') ?? [];

  const extraSignalIds = useMemo(() => {
    if (!rubric) return [];
    const known = new Set(rubric.signals.map((s) => s.id));
    return Object.keys(evaluation.signalResults).filter((id) => !known.has(id));
  }, [rubric, evaluation.signalResults]);

  const signalMentorQuery = useQuery({
    queryKey: ['signal-mentor', evaluation.id],
    queryFn: () => signalMentorService.get(evaluation.id),
    enabled: signalMentorEnabled,
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data;
      const err = q.state.error as { response?: { status?: number } } | null;
      if (data) return false;
      if (err?.response?.status === 404) return 5000;
      return false;
    },
  });
  const signalAnnotations: Record<string, string> =
    signalMentorQuery.data?.artifact.annotations ?? {};
  const signalAnnotationsLoading =
    !signalMentorQuery.data && !signalMentorQuery.isError;

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-gray-100 bg-gray-50/80 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
              {phaseLabel} score
            </div>
            <div className="mt-1 flex items-end gap-2">
              <span className="text-4xl font-semibold tabular-nums leading-none text-gray-950">
                {formatScore(evaluation.score)}
              </span>
              <span className="pb-1 text-sm text-gray-400">/ 5</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            {(() => {
              const verdict = scoreVerdict(evaluation.score);
              return (
                <span
                  className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${verdict.className}`}
                >
                  {verdict.label}
                </span>
              );
            })()}
            <span className="text-[11px] text-gray-500">
              Evaluated {new Date(evaluation.evaluatedAt).toLocaleString()}
            </span>
          </div>
          {!isLatest && (
            <span className="flex items-center gap-1.5">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 ring-1 ring-amber-300">
                historical
              </span>
              <button
                type="button"
                onClick={onShowLatest}
                className="text-[11px] font-medium text-teal-700 hover:underline"
              >
                show latest →
              </button>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
        {rubric && (
          <CoverageSummary signals={rubric.signals} results={evaluation.signalResults} />
        )}
        <AuditTrailButton evaluationId={evaluation.id} />
        </div>
        </div>
      </section>

      {rubric && <ScoreBreakdown rubric={rubric} evaluation={evaluation} />}

      {/*
        Two-call plan eval state machine. Call A persists the row with
        score + signals; Call B patches feedback + top_actions + gaps
        in the background. While Call B is in-flight, show skeletons
        so the user knows more content is on the way (otherwise the
        sections would silently render nothing and look broken).
       */}
      {(() => {
        const isPlanCallBPending =
          evaluation.phase === 'plan' &&
          !evaluation.detailsCompletedAt &&
          !evaluation.detailsError &&
          evaluation.feedbackText === '';

        if (evaluation.phase === 'plan' && evaluation.detailsError) {
          return (
            <section className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-medium mb-1">Details unavailable</div>
              <div className="text-xs">
                {evaluation.detailsError}. Score and signals are based on the first-pass evaluation; evidence quotes, narrative feedback, and gap topics could not be generated.
              </div>
            </section>
          );
        }

        if (isPlanCallBPending) {
          return (
            <>
              <section>
                <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">
                  Feedback
                </h3>
                <DetailsPendingSkeleton lines={3} />
              </section>
              <section>
                <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">
                  Recommended {phaseLabel.toLowerCase()} improvements
                </h3>
                <DetailsPendingSkeleton lines={2} />
              </section>
              <section>
                <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">
                  Gap topics
                </h3>
                <DetailsPendingSkeleton lines={2} />
              </section>
            </>
          );
        }

        return (
          <>
            {evaluation.feedbackText && (
              <DeepDiveDisclosure
                evaluationId={evaluation.id}
                feedbackText={evaluation.feedbackText}
              />
            )}

            {evaluation.topActionableItems.length > 0 && (
              <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50/80 px-4 py-3">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                    ↗
                  </span>
                  <h3 className="text-sm font-semibold text-gray-950">
                    Recommended {phaseLabel.toLowerCase()} improvements
                  </h3>
                </div>
                <ol className="space-y-2 p-4 text-sm">
                  {evaluation.topActionableItems.map((item, i) => (
                    <li key={i} className="flex gap-3 rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-semibold tabular-nums text-emerald-800">
                        {i + 1}
                      </span>
                      <span className="leading-6 text-gray-800">{item}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {evaluation.gapTopics && evaluation.gapTopics.length > 0 && (
              <GapTopicsSection topics={evaluation.gapTopics} />
            )}
          </>
        );
      })()}

      {!rubric ? (
        <section>
          <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-2">
            Signals (raw — rubric not loaded)
          </h3>
          <SignalRowsRaw results={evaluation.signalResults} />
        </section>
      ) : (
        <>
          <SignalGroup
            title="Good signals — presence is positive"
            signals={goodSignals}
            results={evaluation.signalResults}
            weightValues={rubric.weightValues}
            signalAnnotations={signalAnnotations}
            signalAnnotationsLoading={signalAnnotationsLoading}
          />
          <SignalGroup
            title="Bad signals — presence is negative; CRITICAL ones cap the final score"
            signals={badSignals}
            results={evaluation.signalResults}
            weightValues={rubric.weightValues}
            signalAnnotations={signalAnnotations}
            signalAnnotationsLoading={signalAnnotationsLoading}
          />
          {extraSignalIds.length > 0 && (
            <section className="overflow-hidden rounded-lg border border-purple-200 bg-white shadow-sm">
              <div className="border-b border-purple-100 bg-purple-50/80 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-purple-100 text-purple-700">
                      ?
                    </span>
                    <h3 className="text-sm font-semibold text-gray-950">Extra LLM signals</h3>
                  </div>
                  <span className="rounded-full border border-purple-200 bg-white px-2 py-0.5 text-xs font-semibold text-purple-700">
                    {extraSignalIds.length}
                  </span>
                </div>
                <p className="mt-1 text-xs text-purple-700">
                  Returned by the model but not part of this rubric; shown for transparency only.
                </p>
              </div>
              <div className="divide-y divide-purple-100">
                {extraSignalIds.map((id) => {
                  const sig = evaluation.signalResults[id];
                  const style = RESULT_STYLES[sig.result];
                  return (
                    <div key={id} className="flex items-start gap-3 px-4 py-3">
                      <span
                        className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${style.className}`}
                      >
                        {style.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-mono text-gray-900">{id}</div>
                        {sig.evidence && (
                          <div className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">
                            {sig.evidence}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

function DetailsPendingSkeleton({ lines }: { lines: number }) {
  // Subtle pulsing bars while Call B is running. Each bar has a
  // slightly different width so the placeholder doesn't look like a
  // rigid grid; the pulse makes "still loading" obvious vs a section
  // that just has no data.
  const widths = ['w-11/12', 'w-10/12', 'w-9/12', 'w-8/12', 'w-7/12'];
  return (
    <div className="rounded-lg border border-teal-100 bg-teal-50/50 p-4 text-sm">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-teal-800">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-teal-500" />
        Generating evidence + feedback…
      </div>
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`h-3 rounded bg-gray-200 animate-pulse ${widths[i % widths.length]}`}
          />
        ))}
      </div>
    </div>
  );
}

function GapTopicsSection({ topics }: { topics: GapTopic[] }) {
  const humanize = (name: string) =>
    name
      .split('_')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-amber-100 text-amber-700">
            !
          </span>
          <h3 className="text-sm font-semibold text-gray-950">Topics to study</h3>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Expected areas that were missed or only lightly covered.
        </p>
      </div>
      <ul className="divide-y divide-gray-100 text-sm">
        {topics.map((t, i) => {
          const tag =
            t.coverage === 'missed'
              ? { label: 'MISSED', cls: 'bg-rose-100 text-rose-800 border-rose-300' }
              : { label: 'LIGHT', cls: 'bg-amber-100 text-amber-800 border-amber-300' };
          return (
            <li key={`${t.name}-${i}`} className="flex items-start gap-3 px-4 py-3">
              <span
                className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tag.cls}`}
              >
                {tag.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-gray-900">{humanize(t.name)}</div>
                <div className="text-xs text-gray-600 mt-0.5">{t.whyExpected}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CoverageSummary({
  signals,
  results,
}: {
  signals: RubricSignal[];
  results: Record<string, SignalResult>;
}) {
  const counts = { hit: 0, partial: 0, miss: 0, cannot_evaluate: 0, not_evaluated: 0 };
  for (const s of signals) {
    const r = results[s.id];
    if (!r) counts.not_evaluated++;
    else counts[r.result]++;
  }
  return (
    <div className="ml-auto flex items-center gap-3 text-[11px] text-gray-700">
      <span className="font-medium text-gray-800">Coverage ({signals.length}):</span>
      <span className="text-emerald-700">✓ {counts.hit}</span>
      <span className="text-amber-700">~ {counts.partial}</span>
      <span className="text-gray-500">– {counts.miss}</span>
      <span className="text-purple-700">? {counts.not_evaluated}</span>
    </div>
  );
}

function SignalGroup({
  title,
  signals,
  results,
  weightValues,
  signalAnnotations,
  signalAnnotationsLoading,
}: {
  title: string;
  signals: RubricSignal[];
  results: Record<string, SignalResult>;
  weightValues: Record<WeightTier, number>;
  signalAnnotations?: Record<string, string>;
  signalAnnotationsLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () =>
      [...signals].sort((a, b) => {
        const dw = weightValues[b.weight] - weightValues[a.weight];
        if (dw !== 0) return dw;
        return a.id.localeCompare(b.id);
      }),
    [signals, weightValues],
  );
  const isGoodGroup = title.toLowerCase().includes('good');
  const sectionTone = isGoodGroup
    ? {
        icon: '✓',
        iconClass: 'bg-emerald-100 text-emerald-700',
        borderClass: 'border-emerald-200',
        headerClass: 'bg-emerald-50/80 border-emerald-100',
      }
    : {
        icon: '!',
        iconClass: 'bg-rose-100 text-rose-700',
        borderClass: 'border-rose-200',
        headerClass: 'bg-rose-50/80 border-rose-100',
      };

  return (
    <section className={`overflow-hidden rounded-lg border bg-white shadow-sm ${sectionTone.borderClass}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left ${sectionTone.headerClass}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${sectionTone.iconClass}`}>
            {sectionTone.icon}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-gray-950">
              {isGoodGroup ? 'Good signals' : 'Bad signals'}
            </span>
            <span className="mt-0.5 block text-xs font-normal normal-case text-gray-500">
              {isGoodGroup
                ? 'Presence improves the result.'
                : 'Presence hurts the result; critical signals can cap the score.'}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs font-semibold text-gray-700">
            {signals.length}
          </span>
          <span className="text-sm text-gray-500" aria-hidden="true">
            {open ? '⌄' : '›'}
          </span>
        </span>
      </button>
      {open && (
        <div className="divide-y divide-gray-100 bg-white">
          {sorted.map((s) => (
            <SignalRow
              key={s.id}
              signal={s}
              llmResult={results[s.id]}
              mentorAnnotation={signalAnnotations?.[s.id]}
              annotationsLoading={signalAnnotationsLoading}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SignalRow({
  signal,
  llmResult,
  mentorAnnotation,
  annotationsLoading,
}: {
  signal: RubricSignal;
  llmResult: SignalResult | undefined;
  mentorAnnotation?: string;
  annotationsLoading?: boolean;
}) {
  const kind: ResultKind = llmResult ? llmResult.result : 'not_evaluated';
  const resultStyle = RESULT_STYLES[kind];
  const isGap =
    (signal.polarity === 'good' && (kind === 'miss' || kind === 'partial')) ||
    (signal.polarity === 'bad' && (kind === 'hit' || kind === 'partial'));
  const showCoachLoader = isGap && !mentorAnnotation && annotationsLoading;
  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50/70">
      <span
        className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap ${resultStyle.className}`}
      >
        {resultStyle.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-mono text-gray-900">{signal.id}</span>
          <span
            className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${WEIGHT_STYLES[signal.weight]}`}
          >
            {signal.weight}
          </span>
          {signal.critical && (
            <span className="inline-block rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800">
              critical
            </span>
          )}
          {signal.capAtScore !== undefined && (
            <span className="inline-block rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800">
              caps at {signal.capAtScore}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs leading-5 text-gray-700">{signal.description}</div>
        {llmResult?.evidence && (
          <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-600 whitespace-pre-wrap">
            {llmResult.evidence}
          </div>
        )}
        {!llmResult && (
          <div className="text-[11px] text-purple-700 mt-1">
            The LLM did not return a judgment for this signal.
          </div>
        )}
        {mentorAnnotation && (
          <div className="mt-2 rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2">
            <div className="flex items-center gap-1 mb-0.5">
              <CoachBadge />
            </div>
            <p className="text-xs leading-relaxed text-gray-800 whitespace-pre-wrap">
              {mentorAnnotation}
            </p>
          </div>
        )}
        {showCoachLoader && (
          <div className="mt-2 flex items-center gap-1 text-[11px] italic text-gray-400">
            <CoachBadge muted />
            <span>thinking…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CoachBadge({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium ${
        muted ? 'text-gray-400' : 'text-indigo-700'
      }`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-3 h-3"
      >
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </svg>
      Coach
    </span>
  );
}

function SignalRowsRaw({ results }: { results: Record<string, SignalResult> }) {
  const entries = Object.entries(results);
  return (
    <div className="rounded border border-gray-200 divide-y divide-gray-200">
      {entries.map(([id, sig]) => {
        const style = RESULT_STYLES[sig.result];
        return (
          <div key={id} className="px-3 py-2 flex items-start gap-3">
            <span
              className={`shrink-0 mt-0.5 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${style.className}`}
            >
              {style.label}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-mono text-gray-900">{id}</div>
              {sig.evidence && (
                <div className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">
                  {sig.evidence}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AttemptsSection({
  currentSessionId,
  attempts,
  loading,
  selectedEvalId,
  onSelectEval,
}: {
  currentSessionId: string;
  attempts: QuestionWithSessions['sessions'];
  loading: boolean;
  selectedEvalId: string | null;
  onSelectEval: (id: string | null) => void;
}) {
  const ordered = useMemo(
    () =>
      [...attempts].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      ),
    [attempts],
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  if (loading) {
    return (
      <section>
        <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-2">
          Attempts
        </h3>
        <div className="text-xs text-gray-500">Loading…</div>
      </section>
    );
  }
  if (!attempts.length) return null;

  return (
    <section>
      <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-2">
        Attempts ({attempts.length})
      </h3>
      <div className="rounded border border-gray-300 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium w-10">#</th>
              <th className="text-left px-3 py-1.5 font-medium">When</th>
              <th className="text-left px-3 py-1.5 font-medium">Status</th>
              <th className="text-right px-3 py-1.5 font-medium">Plan score</th>
              <th className="text-right px-3 py-1.5 font-medium w-24"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {ordered.map((a, i) => {
              const planEvals = a.phaseEvaluations.filter((e) => e.phase === 'plan');
              const planScore = planEvals[0]?.score;
              const isCurrent = a.id === currentSessionId;
              const hasHistory = planEvals.length > 0;
              const isExpanded = expanded.has(a.id);
              return (
                <Fragment key={a.id}>
                  <tr className={isCurrent ? 'bg-teal-50' : ''}>
                    <td className="px-3 py-1.5 text-gray-500 tabular-nums">
                      {i + 1}
                      {i === 0 && (
                        <span className="ml-1 text-[9px] uppercase tracking-wide text-emerald-700">
                          latest
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-700">
                      {new Date(a.startedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-xs uppercase tracking-wide text-gray-600">
                      {a.status}
                      {isCurrent && (
                        <span className="ml-2 normal-case text-[10px] text-teal-700">
                          (this attempt)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                      {planScore !== undefined && planScore !== null
                        ? formatScore(planScore)
                        : '—'}
                      {planEvals.length > 1 && (
                        <span className="ml-1 text-[10px] font-normal text-gray-500">
                          ×{planEvals.length}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {!isCurrent && (
                          <Link
                            to={
                              a.status === 'active'
                                ? `/sessions/${a.id}/active`
                                : `/sessions/${a.id}`
                            }
                            className="text-teal-700 hover:underline text-xs"
                          >
                            View →
                          </Link>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleExpanded(a.id)}
                          disabled={!hasHistory}
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? 'Hide evaluation history'
                              : 'Show evaluation history'
                          }
                          title={
                            hasHistory
                              ? `${planEvals.length} evaluation${planEvals.length === 1 ? '' : 's'} on this attempt`
                              : 'No evaluations yet'
                          }
                          className="text-xs leading-none text-gray-500 hover:text-gray-800 disabled:text-gray-300 disabled:cursor-not-allowed transition-transform"
                          style={{
                            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          }}
                        >
                          ▼
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isExpanded && hasHistory && (
                    <tr className="bg-slate-100">
                      <td colSpan={5} className="p-0">
                        <div className="mx-4 my-2 rounded-md border border-slate-200 border-l-4 border-l-teal-500 bg-white shadow-sm p-3">
                          <EvaluationHistoryForAttempt
                            planEvals={planEvals}
                            isCurrentAttempt={isCurrent}
                            selectedEvalId={selectedEvalId}
                            onSelectEval={onSelectEval}
                            attemptNumber={i + 1}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvaluationHistoryForAttempt({
  planEvals,
  isCurrentAttempt,
  selectedEvalId,
  onSelectEval,
  attemptNumber,
}: {
  planEvals: PhaseEvaluation[];
  isCurrentAttempt: boolean;
  selectedEvalId: string | null;
  onSelectEval: (id: string | null) => void;
  attemptNumber?: number;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2 pb-1 border-b border-slate-200">
        <span className="text-[11px] uppercase tracking-wider font-semibold text-teal-700">
          ↳ Evaluation history
        </span>
        {attemptNumber !== undefined && (
          <span className="text-[10px] text-gray-500">
            for attempt #{attemptNumber}
          </span>
        )}
        <span className="text-[10px] text-gray-500">
          · {planEvals.length} run{planEvals.length === 1 ? '' : 's'}
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="text-gray-600">
          <tr>
            <th className="text-left font-medium w-10">#</th>
            <th className="text-left font-medium">When</th>
            <th className="text-left font-medium">Model</th>
            <th className="text-right font-medium">Score</th>
            {isCurrentAttempt && (
              <th className="text-right font-medium w-28"></th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {planEvals.map((e, i) => {
            const isShowing = isCurrentAttempt
              ? selectedEvalId
                ? e.id === selectedEvalId
                : i === 0
              : false;
            return (
              <tr key={e.id} className={isShowing ? 'bg-teal-50' : ''}>
                <td className="py-1 text-gray-500 tabular-nums">
                  {i + 1}
                  {i === 0 && (
                    <span className="ml-1 text-[9px] uppercase tracking-wide text-emerald-700">
                      latest
                    </span>
                  )}
                </td>
                <td className="py-1 text-gray-700">
                  {new Date(e.evaluatedAt).toLocaleString()}
                </td>
                <td
                  className="py-1 text-gray-600 font-mono text-[11px]"
                  title={e.modelUsed ?? ''}
                >
                  {formatModelName(e.modelUsed)}
                </td>
                <td className="py-1 text-right font-semibold tabular-nums">
                  {formatScore(e.score)}
                </td>
                {isCurrentAttempt && (
                  <td className="py-1 text-right">
                    {isShowing ? (
                      <span className="text-[10px] text-teal-700">
                        currently shown
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectEval(i === 0 ? null : e.id)
                        }
                        className="text-teal-700 hover:underline text-[11px]"
                      >
                        View →
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CancelledEmptyState({
  siblings,
  currentSessionId,
}: {
  siblings: QuestionWithSessions['sessions'];
  currentSessionId: string;
}) {
  const scoredSibling = [...siblings]
    .filter(
      (s) =>
        s.id !== currentSessionId &&
        s.status === 'completed' &&
        s.phaseEvaluations.some((e) => e.phase === 'plan'),
    )
    .sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0];

  return (
    <div className="rounded border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700 space-y-1">
      <div>
        This attempt was cancelled — no evaluation was generated. You can still
        run one by clicking <strong>Re-evaluate</strong>.
      </div>
      {scoredSibling && (
        <div className="text-xs">
          Or jump to the latest scored attempt of this question:{' '}
          <Link
            to={`/sessions/${scoredSibling.id}`}
            className="text-teal-700 hover:underline"
          >
            view scored attempt →
          </Link>
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({
  label,
  subtitle,
  count,
  rubricVersion,
  open,
  onToggle,
  children,
}: {
  label: string;
  subtitle?: string;
  count: number;
  rubricVersion?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm font-medium text-gray-800 hover:bg-gray-50"
      >
        <span className="min-w-0 flex-1">
          <span>
            {open ? '▼' : '▶'} {label}
          </span>
          {subtitle && (
            <span className="ml-2 text-[11px] font-normal text-gray-500 normal-case">
              {subtitle}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {rubricVersion && (
            <span className="rounded bg-gray-100 text-gray-700 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide">
              rubric: {rubricVersion}
            </span>
          )}
          <span className="text-xs font-normal text-gray-500">
            {count} {count === 1 ? 'entry' : 'entries'}
          </span>
        </span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

function AuditTrailButton({ evaluationId }: { evaluationId: string }) {
  const [open, setOpen] = useState(false);
  const auditQuery = useQuery({
    queryKey: ['eval-audit', evaluationId],
    queryFn: () => evaluationsService.getAudit(evaluationId),
    enabled: open,
    retry: false,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
        title="See the exact prompt sent to the LLM and the raw response"
      >
        View LLM audit →
      </button>
      {open && (
        <AuditTrailModal
          query={auditQuery}
          onDismiss={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AuditTrailModal({
  query,
  onDismiss,
}: {
  query: ReturnType<typeof useQuery<EvaluationAudit>>;
  onDismiss: () => void;
}) {
  const [tab, setTab] = useState<'prompt' | 'response'>('prompt');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-lg bg-white shadow-xl border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-gray-900">LLM audit trail</h2>
            <p className="text-[11px] text-gray-500">
              The exact bytes sent to the model and the raw response before parsing.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {query.isPending && (
          <div className="px-5 py-8 text-sm text-gray-500">Loading audit…</div>
        )}
        {query.isError && (
          <div className="px-5 py-8 text-sm text-red-700">
            Failed to load audit: {extractApiError(query.error)}
          </div>
        )}
        {query.data && (
          <>
            <div className="px-5 py-2 border-b border-gray-200 bg-gray-50 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
              <span>
                model: <span className="font-mono text-gray-800">{query.data.modelUsed}</span>
              </span>
              <span>
                took:{' '}
                <span className="font-mono text-gray-800">
                  {formatLatency(query.data.latencyMs)}
                </span>
              </span>
              <span>
                cost:{' '}
                <span className="font-mono text-gray-800">
                  {formatCostUsd(computeCostUsd(query.data))}
                </span>
              </span>
              <span title="New input tokens billed at full rate (excludes cached portions)">
                input (new): <span className="font-mono text-gray-800">{query.data.tokensIn.toLocaleString()}</span>
              </span>
              <span title="Tokens written into cache this call (1.25x input rate); read for free on the next call within ~5 min">
                cache write: <span className="font-mono text-gray-800">{query.data.cacheCreationTokens.toLocaleString()}</span>
              </span>
              <span title="Tokens read from cache at 0.1x the regular input rate">
                cache read: <span className="font-mono text-gray-800">{query.data.cacheReadTokens.toLocaleString()}</span>
              </span>
              <span>
                output: <span className="font-mono text-gray-800">{query.data.tokensOut.toLocaleString()}</span>
              </span>
              <span>
                captured: <span className="font-mono text-gray-800">{new Date(query.data.createdAt).toLocaleString()}</span>
              </span>
            </div>

            <div className="border-b border-gray-200 px-5 flex gap-1 text-xs">
              <TabButton active={tab === 'prompt'} onClick={() => setTab('prompt')}>
                Prompt sent (
                {(() => {
                  const totalIn =
                    query.data.tokensIn +
                    query.data.cacheCreationTokens +
                    query.data.cacheReadTokens;
                  return totalIn > 0
                    ? `${totalIn.toLocaleString()} tokens`
                    : `${query.data.prompt.length.toLocaleString()} chars`;
                })()}
                )
              </TabButton>
              <TabButton active={tab === 'response'} onClick={() => setTab('response')}>
                Raw response (
                {query.data.tokensOut > 0
                  ? `${query.data.tokensOut.toLocaleString()} tokens`
                  : `${query.data.rawResponse.length.toLocaleString()} chars`}
                )
              </TabButton>
            </div>

            <div className="flex-1 overflow-auto p-3 bg-gray-50">
              <pre className="text-xs font-mono whitespace-pre-wrap break-words text-gray-800">
                {tab === 'prompt' ? query.data.prompt : query.data.rawResponse}
              </pre>
            </div>

            <div className="px-5 py-2 border-t border-gray-200 bg-white flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const text =
                    tab === 'prompt' ? query.data!.prompt : query.data!.rawResponse;
                  navigator.clipboard.writeText(text).catch(() => {});
                }}
                className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Copy {tab}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="rounded bg-gray-800 text-white px-3 py-1 text-xs font-medium hover:bg-gray-900"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 -mb-px border-b-2 ${
        active
          ? 'border-teal-700 text-teal-700 font-medium'
          : 'border-transparent text-gray-600 hover:text-gray-900'
      }`}
    >
      {children}
    </button>
  );
}

function formatRubricTag(
  version: string,
  kind: QuestionKind | null | undefined,
  seniority: Seniority | null | undefined,
): string {
  const parts: string[] = [];
  if (kind) parts.push(kind);
  if (seniority) parts.push(seniority);
  return parts.length ? `${version} (${parts.join(' / ')})` : version;
}

const SENIORITY_BTN_LABEL: Record<Seniority, string> = {
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
};

function RetryButton({
  currentSeniority,
  isPending,
  disabled,
  onRetry,
}: {
  currentSeniority: Seniority | null;
  isPending: boolean;
  disabled: boolean;
  onRetry: (seniority?: Seniority) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useOutsideClickToClose(wrapperRef, showPicker, () => setShowPicker(false));
  useEffect(() => {
    if (isPending) setShowPicker(false);
  }, [isPending]);
  const supportsSeniority = currentSeniority !== null;

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => onRetry()}
        disabled={isPending || disabled}
        className="rounded-l bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        title={
          supportsSeniority
            ? `Start a new attempt (inherits seniority: ${currentSeniority})`
            : "Start a new attempt at this question, pre-loaded with this attempt's plan.md"
        }
      >
        {isPending ? 'Starting…' : 'Try again'}
      </button>
      {supportsSeniority && (
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          disabled={isPending || disabled}
          className="rounded-r bg-emerald-600 text-white px-2 py-1.5 text-sm font-medium border-l border-emerald-700 hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          title="Retry at a different seniority level"
          aria-label="Retry at a different seniority level"
        >
          ▾
        </button>
      )}
      {showPicker && supportsSeniority && (
        <div className="absolute right-0 top-full mt-1 z-10 rounded border border-gray-300 bg-white shadow-md p-2 text-xs whitespace-nowrap">
          <div className="text-gray-500 mb-1">Retry as:</div>
          <div className="inline-flex rounded border border-gray-300 overflow-hidden">
            {SENIORITIES.map((level, i) => {
              const active = level === currentSeniority;
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => {
                    setShowPicker(false);
                    onRetry(level);
                  }}
                  className={`px-3 py-1 ${
                    active
                      ? 'bg-teal-700 text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-100'
                  } ${i > 0 ? 'border-l border-gray-300' : ''}`}
                >
                  {SENIORITY_BTN_LABEL[level]}
                </button>
              );
            })}
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            Default (left button) keeps the current level: {currentSeniority}.
          </div>
        </div>
      )}
    </div>
  );
}

const MODEL_OPTIONS: Array<{ id: string; label: string; tier: string }> = [
  { id: 'claude-haiku-4-5',  label: 'Haiku',  tier: 'fastest, cheapest' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet', tier: 'balanced' },
  { id: 'claude-opus-4-7',   label: 'Opus',   tier: 'most capable' },
];

function ReEvaluateButton({
  isPending,
  onRun,
}: {
  isPending: boolean;
  onRun: (model?: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useOutsideClickToClose(wrapperRef, showPicker, () => setShowPicker(false));
  useEffect(() => {
    if (isPending) setShowPicker(false);
  }, [isPending]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => onRun()}
        disabled={isPending}
        className="rounded-l border border-teal-700 text-teal-700 bg-white px-3 py-1.5 text-sm font-medium hover:bg-teal-50 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Re-run the LLM evaluator on the same plan.md using the env's default model"
      >
        {isPending ? 'Re-evaluating…' : 'Re-evaluate'}
      </button>
      <button
        type="button"
        onClick={() => setShowPicker((v) => !v)}
        disabled={isPending}
        className="rounded-r border border-teal-700 border-l-0 text-teal-700 bg-white px-2 py-1.5 text-sm font-medium hover:bg-teal-50 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Re-evaluate with a specific Anthropic model"
        aria-label="Pick Anthropic model"
      >
        ▾
      </button>
      {showPicker && (
        <div className="absolute right-0 top-full mt-1 z-10 rounded border border-gray-300 bg-white shadow-md p-2 text-xs whitespace-nowrap">
          <div className="text-gray-500 mb-1">Re-evaluate with:</div>
          <div className="flex flex-col gap-1">
            {MODEL_OPTIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setShowPicker(false);
                  onRun(m.id);
                }}
                className="text-left rounded hover:bg-gray-100 px-2 py-1"
              >
                <span className="font-medium text-gray-900">{m.label}</span>
                <span className="ml-2 text-gray-500">{m.tier}</span>
                <div className="font-mono text-[10px] text-gray-400">{m.id}</div>
              </button>
            ))}
          </div>
          <div className="text-[10px] text-gray-500 mt-1 border-t border-gray-200 pt-1">
            Honored by Anthropic, Ollama, and Claude CLI. The audit row
            records the model that ran.
          </div>
        </div>
      )}
    </div>
  );
}

function DeepDiveDisclosure({
  evaluationId,
  feedbackText,
}: {
  evaluationId: string;
  feedbackText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['mentor', evaluationId],
    queryFn: () => mentorService.get(evaluationId),
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data;
      const err = q.state.error as { response?: { status?: number } } | null;
      if (data) return false;
      if (err?.response?.status === 404) return 5000;
      return false;
    },
  });

  const abortRef = useRef<AbortController | null>(null);
  const generateMutation = useMutation({
    mutationFn: () => {
      const controller = new AbortController();
      abortRef.current = controller;
      return mentorService.generate(evaluationId, undefined, controller.signal);
    },
    onSettled: () => {
      abortRef.current = null;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['mentor', evaluationId], data);
      queryClient.invalidateQueries({ queryKey: DAILY_SPEND_QUERY_KEY });
      setExpanded(true);
    },
  });
  const cancelGenerate = () => {
    abortRef.current?.abort();
  };
  const wasCancelled =
    generateMutation.isError &&
    (generateMutation.error as { name?: string; code?: string } | undefined)?.code ===
      'ERR_CANCELED';

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!generateMutation.isPending) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [generateMutation.isPending]);

  const artifact = query.data?.artifact;
  const audit = query.data?.audit;
  const has404 =
    query.error && typeof query.error === 'object' && 'response' in query.error
      ? (query.error as { response?: { status?: number } }).response?.status === 404
      : false;
  // backgroundLikelyRunning covers cold-start only: the eval orchestrator
  // fires the mentor as a background task, so on first page load
  // "no artifact + nothing pending here" implies the background task is
  // still working. Once an explicit user-triggered mutation has errored,
  // we know nothing is running — clear the flag so the spinner doesn't
  // mask the error banner.
  const backgroundLikelyRunning =
    has404 && !artifact && !generateMutation.isPending && !generateMutation.isError;

  const deepDiveRef = useRef<HTMLDivElement>(null);
  const handleClick = () => {
    if (artifact) {
      const willExpand = !expanded;
      setExpanded(willExpand);
      if (willExpand) {
        requestAnimationFrame(() => {
          deepDiveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } else if (!generateMutation.isPending) {
      generateMutation.mutate();
    }
  };

  const buttonLabel = generateMutation.isPending
    ? `Generating deep-dive feedback…  ${elapsed}s`
    : backgroundLikelyRunning
      ? 'Generating deep-dive feedback…'
      : artifact
        ? expanded
          ? 'Hide deep-dive feedback'
          : 'Read the deep-dive feedback'
        : 'Read the deep-dive feedback';

  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-100 text-teal-700">
            ✦
          </span>
          <h3 className="text-sm font-semibold text-gray-950">Mentor feedback</h3>
        </div>
        {audit && (
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-gray-500">
              {formatModelName(audit.modelUsed)} · {formatLatency(audit.latencyMs)}
            </span>
            {!generateMutation.isPending && (
              <button
                type="button"
                onClick={() => generateMutation.mutate()}
                className="text-gray-500 hover:text-gray-800 hover:underline"
                title="Re-run the mentor; overwrites the existing artifact"
              >
                regenerate
              </button>
            )}
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="rounded-lg border border-teal-100 bg-teal-50/50 p-4 text-sm leading-6 text-gray-800 whitespace-pre-wrap">
          {feedbackText}
        </div>

      {/* Prominent disclosure button. Solid bg, centered, with a subtle
          ring-pulse when freshly available so the user notices a new
          deep-dive landed. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-3">
        <div>
          <div className="text-sm font-semibold text-gray-950">Deep-dive review</div>
          <div className="mt-0.5 text-xs text-gray-500">
            Expanded coaching, examples, and next-step guidance.
          </div>
        </div>
        <button
          type="button"
          onClick={handleClick}
          disabled={generateMutation.isPending}
          aria-expanded={expanded}
          aria-controls="deep-dive-panel"
          className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold shadow-sm transition-all ${
            expanded
              ? 'bg-indigo-100 text-indigo-900 ring-1 ring-indigo-300 hover:bg-indigo-200'
              : artifact
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-gray-200 text-gray-700 cursor-wait'
          }`}
          title={
            artifact
              ? 'Toggle the deep-dive feedback'
              : backgroundLikelyRunning
                ? "Mentor is generating in the background — click to force a foreground call"
                : 'Generate the deep-dive feedback now'
          }
        >
          {(generateMutation.isPending || backgroundLikelyRunning) && (
            <span
              className="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"
              aria-hidden="true"
            />
          )}
          <span>{buttonLabel}</span>
          {artifact && !generateMutation.isPending && (
            <span aria-hidden="true" className="text-xs opacity-80">
              {expanded ? '▲' : '▼'}
            </span>
          )}
        </button>
        {generateMutation.isPending && (
          <button
            type="button"
            onClick={cancelGenerate}
            className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
            title="Abort the in-flight mentor generation"
          >
            Cancel
          </button>
        )}
      </div>

      {generateMutation.isError && !wasCancelled && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Mentor generation failed: {extractApiError(generateMutation.error)}
        </div>
      )}

      {expanded && artifact && (
        <div
          id="deep-dive-panel"
          ref={deepDiveRef}
          tabIndex={-1}
          className="mt-4 scroll-mt-4 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 shadow-sm"
        >
          <MentorArtifactView artifact={artifact} />
        </div>
      )}
      </div>
    </section>
  );
}
