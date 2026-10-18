import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { patternDrillsService } from '@/services/patternDrills.service';
import { describeError } from '@/lib/error';
import {
  DrillAnswer,
  DrillItemGrade,
  MANUAL_STATUSES,
  MANUAL_STATUS_LABELS,
  ManualStatus,
  PATTERN_IDS,
  PATTERN_LABELS,
  PatternDrillSet,
  PatternId,
} from '@/types/patternDrill';

interface AnswerDraft {
  pattern: PatternId | '';
  triggerPhrase: string;
  firstMove: string;
}

type QuestionStatus = 'pending' | 'correct' | 'missed';

function statusOf(grade: DrillItemGrade | undefined): QuestionStatus {
  if (!grade) return 'pending';
  return grade.correct ? 'correct' : 'missed';
}

// LeetCode-style status dot: hollow for pending, filled green check /
// filled rose cross once graded — a glance at the sidebar or a row
// tells you where you stand without reading anything.
function StatusDot({ status }: { status: QuestionStatus }) {
  if (status === 'pending') {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-gray-300 dark:border-slate-600"
      />
    );
  }
  const isCorrect = status === 'correct';
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none text-white ${
        isCorrect ? 'bg-emerald-500' : 'bg-rose-500'
      }`}
    >
      {isCorrect ? '✓' : '✕'}
    </span>
  );
}

// LeetCode-style status label: plain colored text, no pill background —
// "Easy"/"Medium"/"Hard" repurposed as "Not answered"/"Correct"/"Missed".
function StatusLabel({ status }: { status: QuestionStatus }) {
  const classes =
    status === 'correct'
      ? 'text-emerald-600 dark:text-emerald-400'
      : status === 'missed'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-gray-400 dark:text-slate-500';
  const text = status === 'correct' ? 'Correct' : status === 'missed' ? 'Missed' : 'Not answered';
  return <span className={`text-xs font-semibold ${classes}`}>{text}</span>;
}

function scoreToneClasses(correct: number, total: number): string {
  if (total === 0) return 'text-gray-400 dark:text-slate-500';
  const ratio = correct / total;
  if (ratio === 1) return 'text-emerald-600 dark:text-emerald-400';
  if (ratio >= 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

type SidebarSectionId = 'todaySet' | 'history' | 'weakSpots';
const SIDEBAR_SECTIONS_KEY = 'pattern-drill-sidebar-collapsed';

function loadCollapsedSections(): Partial<Record<SidebarSectionId, boolean>> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Collapsible sidebar card — icon square + count/status badge + chevron,
// matching the neutral icon-square convention from the sidebar nav
// (AppLayout) and the small colored status dots used on the Feedback
// dashboard.
function SidebarSection({
  icon,
  title,
  badge,
  collapsed,
  onToggle,
  children,
}: {
  icon: string;
  title: string;
  badge?: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-100 text-xs dark:bg-slate-800"
        >
          {icon}
        </span>
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
          {title}
        </span>
        {badge}
        <span aria-hidden="true" className="text-gray-400 dark:text-slate-500">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function PatternDrillPage() {
  const queryClient = useQueryClient();
  const [activeSet, setActiveSet] = useState<PatternDrillSet | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>({});
  const [collapsedSections, setCollapsedSections] =
    useState<Partial<Record<SidebarSectionId, boolean>>>(loadCollapsedSections);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(collapsedSections));
  }, [collapsedSections]);

  const toggleSection = (id: SidebarSectionId) => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Per-question collapse, keyed by itemId. Explicit toggles win; anything
  // not yet toggled falls back to isSubmitted — expanded while you're still
  // answering, collapsed to just the header row once graded, so a finished
  // set reads like a dense list (LeetCode-style) instead of a wall of forms.
  const [collapsedQuestions, setCollapsedQuestions] = useState<Record<string, boolean>>({});
  const toggleQuestion = (itemId: string, fallback: boolean) => {
    setCollapsedQuestions((prev) => ({ ...prev, [itemId]: !(prev[itemId] ?? fallback) }));
  };

  const historyQuery = useQuery({
    queryKey: ['pattern-drills'],
    queryFn: () => patternDrillsService.list(),
  });

  // Resume the most recent set on load without generating a new one — a
  // page refresh shouldn't lose your in-progress set. But only auto-load
  // it as "today's" if it's still unfinished (outstanding, any age — the
  // backend would hand you the same one back anyway) or was actually
  // created today. A stale, already-submitted set from a prior day should
  // NOT silently masquerade as today's drill — that's a stale-data bug,
  // not a resume. This is a plain GET (list), not the withholding POST.
  // list() orders newest-first.
  useEffect(() => {
    if (activeSet || !historyQuery.data || historyQuery.data.length === 0) return;
    const latest = historyQuery.data[0];
    if (latest.submittedAt && !isToday(latest.createdAt)) return;
    setActiveSet(latest);
    seedAnswers(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyQuery.data]);

  // Seeds from the set's own submission when it has one (resuming an
  // already-graded set), otherwise blank drafts (a freshly generated set).
  function seedAnswers(set: PatternDrillSet) {
    const priorByItem = new Map((set.submission ?? []).map((a) => [a.itemId, a]));
    setAnswers(
      Object.fromEntries(
        set.items.map((item) => {
          const prior = priorByItem.get(item.itemId);
          return [
            item.itemId,
            {
              pattern: (prior?.pattern as PatternId) ?? '',
              triggerPhrase: prior?.triggerPhrase ?? '',
              firstMove: prior?.firstMove ?? '',
            } as AnswerDraft,
          ];
        }),
      ),
    );
  }

  const generateMutation = useMutation({
    mutationFn: () => patternDrillsService.generate(),
    onSuccess: (set) => {
      setActiveSet(set);
      seedAnswers(set);
      queryClient.invalidateQueries({ queryKey: ['pattern-drills'] });
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => {
      if (!activeSet) throw new Error('No active set');
      const payload: DrillAnswer[] = activeSet.items.map((item) => {
        const a = answers[item.itemId];
        return {
          itemId: item.itemId,
          pattern: a?.pattern ?? '',
          triggerPhrase: a?.triggerPhrase ?? '',
          firstMove: a?.firstMove ?? '',
        };
      });
      return patternDrillsService.submit(activeSet.id, payload);
    },
    onSuccess: (set) => {
      setActiveSet(set);
      queryClient.invalidateQueries({ queryKey: ['pattern-drills'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => patternDrillsService.delete(id),
    onSuccess: (_data, id) => {
      if (activeSet?.id === id) {
        setActiveSet(null);
        setAnswers({});
      }
      queryClient.invalidateQueries({ queryKey: ['pattern-drills'] });
    },
  });

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this drill set? This cannot be undone.')) return;
    deleteMutation.mutate(id);
  };

  // Personal review status (pending/in_progress/solved) — independent of
  // the LLM-graded correct/missed verdict, editable any time including on
  // a submitted set.
  const statusMutation = useMutation({
    mutationFn: ({ setId, itemId, status }: { setId: string; itemId: string; status: ManualStatus }) =>
      patternDrillsService.setStatus(setId, itemId, status),
    onSuccess: (updatedSet) => {
      setActiveSet(updatedSet);
      queryClient.invalidateQueries({ queryKey: ['pattern-drills'] });
    },
  });

  const isSubmitted = !!activeSet?.submittedAt;

  const gradeByItem = useMemo(() => {
    const map = new Map<string, DrillItemGrade>();
    for (const g of activeSet?.gradedResult ?? []) map.set(g.itemId, g);
    return map;
  }, [activeSet]);

  // Everyday-progress view: sourced entirely from your own submitted
  // history (already fetched for the resume-on-load logic above).
  const submittedSets = useMemo(
    () => (historyQuery.data ?? []).filter((s) => s.submittedAt && s.gradedResult),
    [historyQuery.data],
  );

  const weakSpots = useMemo(() => {
    const agg = new Map<PatternId, { attempts: number; missed: number }>();
    for (const set of submittedSets) {
      for (const grade of set.gradedResult ?? []) {
        const entry = agg.get(grade.pattern) ?? { attempts: 0, missed: 0 };
        entry.attempts += 1;
        if (!grade.correct) entry.missed += 1;
        agg.set(grade.pattern, entry);
      }
    }
    return Array.from(agg.entries())
      .map(([pattern, stats]) => ({ pattern, ...stats }))
      .sort((a, b) => b.missed - a.missed || b.attempts - a.attempts);
  }, [submittedSets]);

  const currentScore = activeSet?.gradedResult
    ? { correct: activeSet.gradedResult.filter((g) => g.correct).length, total: activeSet.gradedResult.length }
    : null;

  const canSubmit =
    !!activeSet &&
    !isSubmitted &&
    activeSet.items.every((item) => {
      const a = answers[item.itemId];
      return !!a && !!a.pattern && a.triggerPhrase.trim().length > 0;
    });

  // True when the center pane is showing a past day's set (opened from
  // History), not today's live/outstanding one.
  const isHistoricalView = !!activeSet && !!activeSet.submittedAt && !isToday(activeSet.createdAt);

  const viewHistorySet = (set: PatternDrillSet) => {
    setActiveSet(set);
    seedAnswers(set);
  };

  const backToToday = () => {
    setActiveSet(null);
    setAnswers({});
  };

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      {/* Top bar — title + primary action together, always visible */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-4 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-gray-950 dark:text-slate-100">Pattern Drill</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-slate-400">
            5 questions a day. Name the pattern and the trigger phrase before you code.
          </p>
        </div>
        <button
          type="button"
          disabled={generateMutation.isPending}
          onClick={() => generateMutation.mutate()}
          className="inline-flex h-9 items-center justify-center rounded-md bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {generateMutation.isPending ? 'Generating…' : "Get today's set"}
        </button>
      </div>
      {generateMutation.isError && (
        <p className="text-sm text-rose-700 dark:text-rose-300">{describeError(generateMutation.error)}</p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* Main: today's questions */}
        <main className="space-y-3 lg:order-1">
          {!activeSet && (
            <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 shadow-sm dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
              No active set. Click "Get today's set" to start.
            </div>
          )}

          {isHistoricalView && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
              <span>
                Viewing the set from{' '}
                {new Date(activeSet!.createdAt).toLocaleDateString(undefined, {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
                .
              </span>
              <button
                type="button"
                onClick={backToToday}
                className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
              >
                Back to today
              </button>
            </div>
          )}

          {activeSet?.isOutstanding && !isSubmitted && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              You have an unsubmitted set from earlier — finish this one before requesting new material.
            </div>
          )}

          {activeSet && (
            <>
              <div className="flex items-center justify-between gap-3">
                {isSubmitted && currentScore ? (
                  <p className="text-sm text-gray-600 dark:text-slate-400">
                    <span className={`font-semibold tabular-nums ${scoreToneClasses(currentScore.correct, currentScore.total)}`}>
                      {currentScore.correct}/{currentScore.total}
                    </span>{' '}
                    {currentScore.correct === currentScore.total
                      ? '— clean set.'
                      : '— see the explanation on each miss below.'}
                  </p>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(activeSet.id)}
                  disabled={deleteMutation.isPending}
                  className="text-xs font-medium text-gray-400 hover:text-rose-600 disabled:opacity-50 dark:text-slate-500 dark:hover:text-rose-400"
                >
                  Delete this set
                </button>
              </div>
              {deleteMutation.isError && (
                <p className="text-sm text-rose-700 dark:text-rose-300">{describeError(deleteMutation.error)}</p>
              )}
              {statusMutation.isError && (
                <p className="text-sm text-rose-700 dark:text-rose-300">{describeError(statusMutation.error)}</p>
              )}

              {activeSet.items.map((item, idx) => {
                const grade = gradeByItem.get(item.itemId);
                const answer = answers[item.itemId];
                const status = statusOf(grade);
                // Not explicitly toggled yet: expanded while still
                // answering, collapsed once graded (LeetCode-style dense
                // row you open on demand rather than a permanent form).
                const collapsed = collapsedQuestions[item.itemId] ?? isSubmitted;
                return (
                  <div
                    key={item.itemId}
                    id={`q-${idx + 1}`}
                    className="rounded-md border border-gray-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950"
                  >
                    <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5 dark:border-slate-800">
                      <button
                        type="button"
                        onClick={() => toggleQuestion(item.itemId, isSubmitted)}
                        className="flex items-center gap-2"
                      >
                        <StatusDot status={status} />
                        <span className="text-sm font-medium text-gray-700 dark:text-slate-300">
                          Question {idx + 1}
                        </span>
                      </button>

                      <select
                        value={activeSet.manualStatus?.[item.itemId] ?? 'pending'}
                        onChange={(e) =>
                          statusMutation.mutate({
                            setId: activeSet.id,
                            itemId: item.itemId,
                            status: e.target.value as ManualStatus,
                          })
                        }
                        disabled={statusMutation.isPending}
                        aria-label={`Review status for question ${idx + 1}`}
                        className="ml-auto h-7 rounded-md border border-gray-300 px-1.5 text-xs disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        {MANUAL_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {MANUAL_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>

                      <StatusLabel status={status} />

                      <button
                        type="button"
                        onClick={() => toggleQuestion(item.itemId, isSubmitted)}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? 'Expand question' : 'Collapse question'}
                        className="text-gray-400 dark:text-slate-500"
                      >
                        {collapsed ? '▸' : '▾'}
                      </button>
                    </div>

                    {!collapsed && (
                    <div className="p-4">
                      <p className="text-sm text-gray-900 dark:text-slate-100">{item.statement}</p>

                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <div>
                          <label className="text-xs font-medium text-gray-600 dark:text-slate-400">Pattern</label>
                          <select
                            disabled={isSubmitted}
                            value={answer?.pattern ?? ''}
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [item.itemId]: { ...prev[item.itemId], pattern: e.target.value as PatternId },
                              }))
                            }
                            className="mt-1 h-9 w-full rounded-md border border-gray-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          >
                            <option value="">Select…</option>
                            {PATTERN_IDS.map((p) => (
                              <option key={p} value={p}>
                                {PATTERN_LABELS[p]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-gray-600 dark:text-slate-400">
                            Trigger phrase
                          </label>
                          <input
                            disabled={isSubmitted}
                            value={answer?.triggerPhrase ?? ''}
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [item.itemId]: { ...prev[item.itemId], triggerPhrase: e.target.value },
                              }))
                            }
                            maxLength={300}
                            className="mt-1 h-9 w-full rounded-md border border-gray-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-gray-600 dark:text-slate-400">
                            First move{' '}
                            <span className="font-normal normal-case text-gray-400 dark:text-slate-500">
                              (optional)
                            </span>
                          </label>
                          <input
                            disabled={isSubmitted}
                            value={answer?.firstMove ?? ''}
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [item.itemId]: { ...prev[item.itemId], firstMove: e.target.value },
                              }))
                            }
                            maxLength={300}
                            className="mt-1 h-9 w-full rounded-md border border-gray-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        </div>
                      </div>

                      {grade && !grade.correct && (
                        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                          {grade.explanation}
                        </div>
                      )}
                    </div>
                    )}
                  </div>
                );
              })}

              {!isSubmitted && (
                <button
                  type="button"
                  disabled={!canSubmit || submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                >
                  {submitMutation.isPending ? 'Grading…' : 'Submit set'}
                </button>
              )}
              {submitMutation.isError && (
                <p className="text-sm text-rose-700 dark:text-rose-300">{describeError(submitMutation.error)}</p>
              )}
            </>
          )}
        </main>

        {/* Right sidebar: today's set at a glance + history */}
        <aside className="space-y-4 lg:order-2">
          {activeSet && (
            <SidebarSection
              icon={isHistoricalView ? '🕘' : '🎯'}
              title={isHistoricalView ? 'Viewing this set' : "Today's set"}
              collapsed={!!collapsedSections.todaySet}
              onToggle={() => toggleSection('todaySet')}
              badge={
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full ${
                    !isSubmitted
                      ? 'bg-gray-300 dark:bg-slate-600'
                      : currentScore && currentScore.correct === currentScore.total
                        ? 'bg-emerald-500'
                        : 'bg-amber-500'
                  }`}
                />
              }
            >
              <ul className="space-y-0.5">
                {activeSet.items.map((item, idx) => {
                  const status = statusOf(gradeByItem.get(item.itemId));
                  return (
                    <li key={item.itemId}>
                      <a
                        href={`#q-${idx + 1}`}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-900"
                      >
                        <StatusDot status={status} />
                        <span className="flex-1 text-gray-700 dark:text-slate-300">Question {idx + 1}</span>
                        <StatusLabel status={status} />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </SidebarSection>
          )}

          <SidebarSection
            icon="📅"
            title="History"
            collapsed={!!collapsedSections.history}
            onToggle={() => toggleSection('history')}
            badge={
              <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-slate-800 dark:text-slate-300">
                {submittedSets.length}
              </span>
            }
          >
            {submittedSets.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-slate-400">
                Submit your first set to start tracking history.
              </p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                {submittedSets.map((set) => {
                  const grades = set.gradedResult ?? [];
                  const correct = grades.filter((g) => g.correct).length;
                  const isSelected = activeSet?.id === set.id;
                  return (
                    <li
                      key={set.id}
                      className={`flex items-center gap-1 rounded-md pr-1 text-sm ${
                        isSelected ? 'bg-teal-50 dark:bg-teal-500/10' : 'hover:bg-gray-50 dark:hover:bg-slate-900'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => viewHistorySet(set)}
                        aria-current={isSelected}
                        className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left"
                      >
                        <span
                          className={`flex-1 ${isSelected ? 'font-semibold text-teal-800 dark:text-teal-200' : 'text-gray-600 dark:text-slate-400'}`}
                        >
                          {new Date(set.submittedAt as string).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        <span className={`font-semibold tabular-nums ${scoreToneClasses(correct, grades.length)}`}>
                          {correct}/{grades.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(set.id)}
                        disabled={deleteMutation.isPending}
                        aria-label="Delete this drill set"
                        title="Delete this drill set"
                        className="shrink-0 text-gray-300 hover:text-rose-600 disabled:opacity-50 dark:text-slate-600 dark:hover:text-rose-400"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SidebarSection>

          {weakSpots.length > 0 && (
            <SidebarSection
              icon="⚠️"
              title="Weak spots"
              collapsed={!!collapsedSections.weakSpots}
              onToggle={() => toggleSection('weakSpots')}
              badge={
                <span className="rounded-md bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                  {weakSpots.length}
                </span>
              }
            >
              <ul className="space-y-2">
                {weakSpots.slice(0, 8).map(({ pattern, missed, attempts }) => (
                  <li key={pattern} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-gray-700 dark:text-slate-300">{PATTERN_LABELS[pattern]}</span>
                      <span className="shrink-0 tabular-nums text-gray-500 dark:text-slate-400">
                        {missed}/{attempts}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-slate-800">
                      <div
                        className="h-1.5 rounded-full bg-rose-400"
                        style={{ width: `${Math.round((missed / attempts) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </SidebarSection>
          )}
        </aside>
      </div>
    </section>
  );
}
