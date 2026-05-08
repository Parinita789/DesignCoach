import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { questionsService } from '@/services/questions.service';
import { useSessionStore } from '@/store/sessionStore';
import { extractApiError } from '@/lib/error';
import type { Seniority } from '@/types/question';

// Clicking a question in the sidebar (or landing here after deleting the
// last attempt) routes the user to the most useful state for that question:
//   1. in-progress (active) session → its editor
//   2. most recently completed session → its results page
//   3. fall back to the most recent session of any status
//   4. if the question has no sessions at all → render an inline empty
//      state with a Retry button so the user can start fresh without
//      losing the question itself.
export function QuestionRedirectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActive = useSessionStore((s) => s.setActive);

  const questionQuery = useQuery({
    queryKey: ['question', id],
    queryFn: () => questionsService.get(id!),
    enabled: !!id,
  });

  const retryMutation = useMutation({
    mutationFn: (seniority?: Seniority) => questionsService.startAttempt(id!, seniority),
    onSuccess: (newSession) => {
      setActive(newSession.id, newSession.startedAt);
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      queryClient.invalidateQueries({ queryKey: ['question', id] });
      navigate(`/sessions/${newSession.id}/active`);
    },
  });

  useEffect(() => {
    if (!id) {
      navigate('/home', { replace: true });
      return;
    }
    if (questionQuery.isError) {
      navigate('/home', { replace: true });
      return;
    }
    if (!questionQuery.data) return;
    const sessions = questionQuery.data.sessions;
    if (sessions.length === 0) return; // empty state rendered below

    const active = sessions.find((s) => s.status === 'active');
    if (active) {
      navigate(`/sessions/${active.id}/active`, { replace: true });
      return;
    }

    const byStartedDesc = (a: { startedAt: string }, b: { startedAt: string }) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();

    // Prefer the most recently completed attempt — it has an evaluation.
    const newestCompleted = [...sessions]
      .filter((s) => s.status === 'completed')
      .sort(byStartedDesc)[0];
    if (newestCompleted) {
      navigate(`/sessions/${newestCompleted.id}`, { replace: true });
      return;
    }

    // Last resort: a question whose only attempts are abandoned.
    const newest = [...sessions].sort(byStartedDesc)[0];
    navigate(`/sessions/${newest.id}`, { replace: true });
  }, [id, questionQuery.isError, questionQuery.data, navigate]);

  if (!questionQuery.data) {
    return <div className="text-sm text-gray-500">Loading question…</div>;
  }

  const sessions = questionQuery.data.sessions;
  if (sessions.length > 0) {
    // useEffect above is redirecting; keep the page minimal during the
    // transition so we don't flash a stale view.
    return <div className="text-sm text-gray-500">Loading…</div>;
  }

  const error = retryMutation.isError ? extractApiError(retryMutation.error) : null;

  return (
    <div className="max-w-3xl mx-auto space-y-4 pt-2">
      <h2 className="text-xl font-semibold">Question</h2>
      <div className="rounded border border-gray-300 bg-gray-50 px-3 py-2 text-sm whitespace-pre-wrap font-mono">
        {questionQuery.data.prompt}
      </div>
      <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm text-amber-900">
          No attempts for this question. Start a fresh attempt to give it
          another go — your prior attempts can't be recovered, but the
          question itself is still here.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => retryMutation.mutate(undefined)}
            disabled={retryMutation.isPending}
            className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {retryMutation.isPending ? 'Starting…' : 'Retry this question'}
          </button>
          <span className="text-[11px] text-gray-500">
            New attempt will inherit the latest seniority default for this question.
          </span>
        </div>
        {error && (
          <div className="mt-2 text-xs text-red-700">
            Couldn't start a new attempt: {error}
          </div>
        )}
      </div>
    </div>
  );
}
