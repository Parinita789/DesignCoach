import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { questionsService } from '@/services/questions.service';
import { useSessionStore } from '@/store/sessionStore';
import { describeError } from '@/lib/error';
import {
  QUESTION_KIND_LABELS,
  QUESTION_KINDS,
  QuestionKind,
  QuestionWithSessions,
  SENIORITIES,
  Seniority,
} from '@/types/question';

const MIN_PROMPT_LENGTH = 10;

const AGENTIC_VOCAB = /\b(agent|agents|agentic|llm|llms|ai\s|ai-|tool[\s-]?use|chatbot|copilot|gpt|rag|retrieval[\s-]?augmented)\b/i;
const BUILDABLE_VOCAB = /\b(build|implement|ship|prototype|in\s+(?:1|one)\s*hour|live\s*demo)\b/i;

function classifyKind(prompt: string): QuestionKind {
  const isAgentic = AGENTIC_VOCAB.test(prompt);
  const isBuildable = BUILDABLE_VOCAB.test(prompt);
  if (isAgentic && isBuildable) return 'agentic_build';
  if (isAgentic) return 'agentic_design';
  return 'traditional_design';
}

const PROMPT_STARTERS = [
  {
    label: 'Traditional design',
    kind: 'traditional_design',
    prompt: 'Design a URL shortener that handles 100M URLs/day with sub-50ms read latency.',
  },
  {
    label: 'AI design',
    kind: 'agentic_design',
    prompt: 'Design an AI code review assistant that comments on pull requests and learns team style.',
  },
  {
    label: 'Build agent',
    kind: 'agentic_build',
    prompt: 'Build a one-hour agent that summarizes incident logs and proposes next debugging steps.',
  },
] satisfies Array<{ label: string; kind: QuestionKind; prompt: string }>;

type StatusFilter = 'all' | 'active' | 'completed' | 'unattempted';

const METRIC_META = {
  questions: {
    icon: '📚',
    accent: 'from-teal-500 to-slate-700',
    tint: 'bg-sky-50 text-sky-700',
  },
  completed: {
    icon: '✅',
    accent: 'from-amber-500 to-teal-700',
    tint: 'bg-emerald-50 text-emerald-700',
  },
  best: {
    icon: '🏆',
    accent: 'from-amber-400 to-orange-500',
    tint: 'bg-amber-50 text-amber-700',
  },
  latest: {
    icon: '⚡',
    accent: 'from-amber-500 to-rose-500',
    tint: 'bg-amber-50 text-amber-700',
  },
} as const;

export function SessionStartPage() {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<QuestionKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const questionsQuery = useQuery({
    queryKey: ['questions'],
    queryFn: () => questionsService.list(),
  });
  const questions = questionsQuery.data ?? [];
  const stats = useMemo(() => buildHomeStats(questions), [questions]);
  const activeSessions = useMemo(() => buildActiveSessionLinks(questions), [questions]);
  const visibleQuestions = useMemo(
    () => filterQuestions(questions, { query, kind: kindFilter, status: statusFilter }),
    [kindFilter, query, questions, statusFilter],
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 via-teal-50 to-green-100 px-5 py-5 text-gray-950 dark:border-emerald-800/70 dark:from-emerald-800 dark:via-teal-800 dark:to-green-800 dark:text-white lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Sharpen the next system design round</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-teal-100">
              Track attempted prompts, find unfinished sessions, and start a focused practice run.
            </p>
          </div>
          <Link
            to="/practice/new"
            className="inline-flex h-10 items-center justify-center rounded-md bg-teal-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 dark:bg-white dark:text-gray-950 dark:hover:bg-teal-50"
          >
            + New Question
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          meta={METRIC_META.questions}
          label="Questions"
          value={stats.questionCount.toString()}
          detail="Practice prompts"
          isLoading={questionsQuery.isPending}
        />
        <MetricCard
          meta={METRIC_META.completed}
          label="Completed"
          value={stats.completedCount.toString()}
          detail={`${stats.activeCount} active session${stats.activeCount === 1 ? '' : 's'}`}
          isLoading={questionsQuery.isPending}
        />
        <MetricCard
          meta={METRIC_META.best}
          label="Best score"
          value={stats.bestScore === null ? '—' : stats.bestScore.toFixed(2)}
          detail={stats.bestScore === null ? 'Evaluate a session' : 'Highest score'}
          isLoading={questionsQuery.isPending}
        />
        <MetricCard
          meta={METRIC_META.latest}
          label="Latest"
          value={
            activeSessions[0]
              ? 'Active'
              : stats.latestScore === null
                ? '-'
                : stats.latestScore.toFixed(2)
          }
          detail={
            activeSessions[0]
              ? `Started ${relativeTime(activeSessions[0].startedAt)}`
              : stats.latestDate
                ? `Ended ${relativeTime(stats.latestDate)}`
                : 'No results yet'
          }
          isLoading={questionsQuery.isPending}
          action={
            activeSessions[0]
              ? {
                  label: 'Resume',
                  to: `/sessions/${activeSessions[0].id}/active`,
                }
              : undefined
          }
        />
      </section>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 bg-gray-50/80 px-4 py-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-100 text-teal-700">
                ✦
              </span>
              Practice questions
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search questions"
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100 sm:w-64"
              />
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value as QuestionKind | 'all')}
                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-700 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
              >
                <option value="all">All kinds</option>
                {QUESTION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {QUESTION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-700 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
              >
                <option value="all">All status</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="unattempted">Unattempted</option>
              </select>
            </div>
          </div>
        </div>

        {questionsQuery.isPending ? (
          <QuestionTableSkeleton />
        ) : questionsQuery.isError ? (
          <div className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Failed to load questions: {describeError(questionsQuery.error)}
          </div>
        ) : visibleQuestions.length === 0 ? (
          <div className="m-4 rounded-lg border border-dashed border-teal-200 bg-teal-50/60 px-4 py-12 text-center">
            <div className="text-3xl" aria-hidden="true">
              🔎
            </div>
            <div className="mt-2 text-sm font-semibold text-gray-900">No matching questions</div>
            <p className="mt-1 text-sm text-gray-600">
              Adjust the filters or create a new practice prompt.
            </p>
          </div>
        ) : (
          <QuestionTable questions={visibleQuestions} />
        )}
      </section>
    </div>
  );
}

export function NewQuestionPracticePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActive = useSessionStore((s) => s.setActive);
  const [prompt, setPrompt] = useState('');
  const [userKind, setUserKind] = useState<QuestionKind | null>(null);
  const [seniority, setSeniority] = useState<Seniority>('senior');

  const trimmed = prompt.trim();
  const inferredKind = useMemo(
    () => (trimmed ? classifyKind(trimmed) : null),
    [trimmed],
  );
  const effectiveKind = userKind ?? inferredKind;

  const mutation = useMutation({
    mutationFn: (p: { prompt: string; kind: QuestionKind | null; seniority: Seniority }) =>
      questionsService.create({
        prompt: p.prompt,
        ...(p.kind ? { kind: p.kind } : {}),
        seniority: p.seniority,
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      setActive(session.id, session.startedAt);
      navigate(`/sessions/${session.id}/active`);
    },
  });

  const tooShort = trimmed.length > 0 && trimmed.length < MIN_PROMPT_LENGTH;
  const canSubmit = trimmed.length >= MIN_PROMPT_LENGTH && !mutation.isPending;

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate({ prompt: trimmed, kind: effectiveKind, seniority });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div>
        <Link
          to="/home"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:text-teal-900"
        >
          <span aria-hidden="true">←</span>
          Back to questions
        </Link>
      </div>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 bg-gradient-to-r from-white via-slate-50 to-teal-50 px-5 py-5 text-gray-950 dark:from-gray-950 dark:via-slate-800 dark:to-teal-900 dark:text-white sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Create a new practice question</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-teal-100">
              Paste your prompt, pick the interview level, and start a focused system design session.
            </p>
          </div>
          <div className="hidden rounded-lg bg-white px-4 py-3 text-sm text-gray-900 ring-1 ring-gray-200 dark:bg-white/10 dark:text-white dark:ring-white/15 sm:block">
            <div className="font-semibold">Ready when your prompt is clear</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-teal-100">Minimum {MIN_PROMPT_LENGTH} characters</div>
          </div>
        </div>
      </section>

      <section>
        <form
          onSubmit={handleSubmit}
          className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
        >
          <div className="border-b border-gray-100 bg-gray-50/80 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-100 text-teal-700">
                ✎
              </span>
              Prompt
            </div>
          </div>

          <div className="space-y-5 p-4">
            <label className="block">
              <div className="w-full">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={6}
                  placeholder="e.g. Design a URL shortener that handles 100M URLs/day with sub-50ms read latency."
                  className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-mono shadow-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                  disabled={mutation.isPending}
                  autoFocus
                />
              </div>
              {tooShort && (
                <span className="mt-2 block text-xs font-medium text-red-600">
                  Question must be at least {MIN_PROMPT_LENGTH} characters.
                </span>
              )}
            </label>

            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Prompt starters
              </div>
              <div className="flex flex-wrap gap-2">
                {PROMPT_STARTERS.map((starter) => {
                  const selected = effectiveKind === starter.kind;
                  return (
                    <button
                      key={starter.label}
                      type="button"
                      onClick={() => {
                        setPrompt(starter.prompt);
                        setUserKind(starter.kind);
                      }}
                      disabled={mutation.isPending}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm transition-colors disabled:opacity-50 ${
                        selected
                          ? 'border-teal-800 bg-teal-700 text-white'
                          : 'border-teal-100 bg-white text-gray-700 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800'
                      }`}
                    >
                      {starter.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <SeniorityPicker
              value={seniority}
              onPick={setSeniority}
              disabled={mutation.isPending}
            />

            <div className="flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-gray-500">
                {trimmed.length ? `${trimmed.length} characters` : 'Start with a concrete system prompt'}
              </div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-10 items-center justify-center rounded-md bg-teal-700 px-5 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {mutation.isPending ? 'Starting…' : 'Start session'}
              </button>
            </div>

            {mutation.isError && (
              <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                Failed to start session: {describeError(mutation.error)}
              </div>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function filterQuestions(
  questions: QuestionWithSessions[],
  filters: { query: string; kind: QuestionKind | 'all'; status: StatusFilter },
) {
  const q = filters.query.trim().toLowerCase();
  return questions.filter((question) => {
    if (filters.kind !== 'all' && question.kind !== filters.kind) return false;
    if (q && !question.prompt.toLowerCase().includes(q)) return false;
    if (filters.status === 'all') return true;
    if (filters.status === 'unattempted') return question.sessions.length === 0;
    return question.sessions.some((session) => session.status === filters.status);
  });
}

function QuestionTable({ questions }: { questions: QuestionWithSessions[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="border-b border-gray-100 bg-white text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-2 font-medium">Question</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Attempts</th>
            <th className="px-3 py-2 text-right font-medium">Best</th>
            <th className="px-3 py-2 text-right font-medium">Last</th>
            <th className="px-4 py-2 text-right font-medium">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {questions.map((question) => {
            const summary = summarizeQuestion(question);
            const activeSession = latestActiveSession(question);
            return (
              <tr key={question.id} className="group transition-colors hover:bg-sky-50/70">
                <td className="px-4 py-3">
                  <Link to={`/questions/${question.id}`} className="block">
                    <div className="line-clamp-2 font-medium text-gray-950 group-hover:text-teal-800">
                      {question.prompt}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Created {relativeTime(question.createdAt)}
                    </div>
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <KindPill kind={question.kind} />
                </td>
                <td className="px-3 py-3">
                  <StatusPill status={summary.status} />
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-gray-700">
                  {question.sessions.length}
                </td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums text-gray-900">
                  {summary.bestScore === null ? '—' : summary.bestScore.toFixed(2)}
                </td>
                <td className="px-3 py-3 text-right text-xs text-gray-500">
                  {summary.lastAttemptAt ? relativeTime(summary.lastAttemptAt) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {activeSession ? (
                    <Link
                      to={`/sessions/${activeSession.id}/active`}
                      className="inline-flex h-8 items-center justify-center rounded-md bg-teal-700 px-3 text-xs font-semibold text-white shadow-sm hover:bg-teal-800"
                    >
                      Resume
                    </Link>
                  ) : (
                    <Link
                      to={`/questions/${question.id}`}
                      className="text-xs font-medium text-teal-700 hover:text-teal-900 hover:underline"
                    >
                      View
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KindPill({ kind }: { kind: QuestionKind }) {
  const styles = {
    traditional_design: 'border-sky-200 bg-sky-50 text-sky-700',
    agentic_design: 'border-amber-200 bg-amber-50 text-amber-700',
    agentic_build: 'border-amber-200 bg-amber-50 text-amber-700',
  } satisfies Record<QuestionKind, string>;

  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${styles[kind]}`}>
      {QUESTION_KIND_LABELS[kind]}
    </span>
  );
}

function summarizeQuestion(question: QuestionWithSessions) {
  const active = question.sessions.some((session) => session.status === 'active');
  const completed = question.sessions.some((session) => session.status === 'completed');
  const scores = question.sessions
    .flatMap((session) => session.phaseEvaluations.map((evaluation) => Number(evaluation.score)))
    .filter((score) => Number.isFinite(score));
  const lastAttemptAt =
    question.sessions
      .map((session) => session.startedAt)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  return {
    status: (
      active ? 'active' : completed ? 'completed' : question.sessions.length ? 'attempted' : 'new'
    ) as 'active' | 'completed' | 'attempted' | 'new',
    bestScore: scores.length ? Math.max(...scores) : null,
    lastAttemptAt,
  };
}

function latestActiveSession(question: QuestionWithSessions) {
  return (
    [...question.sessions]
      .filter((session) => session.status === 'active')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ??
    null
  );
}

function buildActiveSessionLinks(questions: QuestionWithSessions[]) {
  return questions
    .flatMap((question) =>
      question.sessions
        .filter((session) => session.status === 'active')
        .map((session) => ({
          id: session.id,
          startedAt: session.startedAt,
          prompt: question.prompt,
          kind: question.kind,
        })),
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function StatusPill({ status }: { status: 'active' | 'completed' | 'attempted' | 'new' }) {
  const styles = {
    active: 'border-teal-200 bg-teal-50 text-teal-700',
    completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    attempted: 'border-amber-200 bg-amber-50 text-amber-700',
    new: 'border-gray-200 bg-white text-gray-600',
  } satisfies Record<typeof status, string>;

  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}>
      {status}
    </span>
  );
}

function buildHomeStats(questions: QuestionWithSessions[]) {
  const attempts = questions
    .flatMap((question) =>
      question.sessions.map((session) => ({
        ...session,
        prompt: question.prompt,
        score: bestSessionScore(session.phaseEvaluations),
      })),
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const completed = attempts.filter((attempt) => attempt.status === 'completed');
  const active = attempts.filter((attempt) => attempt.status === 'active');
  const scored = attempts
    .map((attempt) => attempt.score)
    .filter((score): score is number => score !== null);
  const latestCompleted = completed[0] ?? null;

  return {
    questionCount: questions.length,
    completedCount: completed.length,
    activeCount: active.length,
    bestScore: scored.length ? Math.max(...scored) : null,
    latestScore: latestCompleted?.score ?? null,
    latestDate: latestCompleted?.endedAt ?? null,
  };
}

function bestSessionScore(evaluations: QuestionWithSessions['sessions'][number]['phaseEvaluations']) {
  const scores = evaluations
    .map((evaluation) => Number(evaluation.score))
    .filter((score) => Number.isFinite(score));
  return scores.length ? Math.max(...scores) : null;
}

function relativeTime(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function MetricCard({
  meta,
  label,
  value,
  detail,
  isLoading,
  action,
}: {
  meta: {
    icon: string;
    accent: string;
    tint: string;
  };
  label: string;
  value: string;
  detail: string;
  isLoading: boolean;
  action?: {
    label: string;
    to: string;
  };
}) {
  return (
    <div className="group overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className={`h-1 bg-gradient-to-r ${meta.accent}`} />
      <div className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
        <div className={`flex h-8 w-8 items-center justify-center rounded-md text-base ${meta.tint}`}>
          <span aria-hidden="true">{meta.icon}</span>
        </div>
      </div>
      {isLoading ? (
        <div className="mt-3 h-8 w-20 animate-pulse rounded bg-gray-200" />
      ) : (
        <div className="mt-2 text-2xl font-semibold tabular-nums text-gray-950">{value}</div>
      )}
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="text-xs text-gray-500">{detail}</div>
        {action && !isLoading && (
          <Link
            to={action.to}
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-md bg-teal-700 px-3 text-xs font-semibold text-white shadow-sm hover:bg-teal-800"
          >
            {action.label}
          </Link>
        )}
      </div>
      </div>
    </div>
  );
}

function QuestionTableSkeleton() {
  return (
    <div className="space-y-1 p-4">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-md bg-gray-100" />
      ))}
    </div>
  );
}

const SENIORITY_LABEL: Record<Seniority, string> = {
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
};

function SeniorityPicker({
  value,
  onPick,
  disabled,
}: {
  value: Seniority;
  onPick: (s: Seniority) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 text-sm">
      <span className="text-gray-700 font-medium">Seniority</span>
      <div className="grid grid-cols-4 overflow-hidden rounded-md border border-gray-300">
        {SENIORITIES.map((level, i) => {
          const isActive = value === level;
          return (
            <button
              key={level}
              type="button"
              onClick={() => onPick(level)}
              disabled={disabled}
              className={`px-2 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-teal-700 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100 disabled:text-gray-400 disabled:hover:bg-white'
              } ${i > 0 ? 'border-l border-gray-300' : ''}`}
            >
              {SENIORITY_LABEL[level]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
