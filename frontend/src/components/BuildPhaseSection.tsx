import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildSessionsService } from '@/services/buildSessions.service';
import { extractApiError } from '@/lib/error';
import { Session } from '@/types/session';
import { BuildEventsSummary } from '@/types/buildEvent';

export function BuildPhaseSection({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const [issuedBuildStartedAt, setIssuedBuildStartedAt] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: () => buildSessionsService.startBuild(session.id),
    onSuccess: (minted) => {
      setIssuedToken(minted.token);
      setIssuedBuildStartedAt(minted.buildStartedAt);
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
    },
  });

  const summaryQuery = useQuery({
    queryKey: ['build-events', session.id],
    queryFn: () => buildSessionsService.eventsSummary(session.id),
    enabled: !!session.buildStartedAt,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data?.buildEndedAt) return false;
      return 5000;
    },
  });

  // When the poll detects the build finished, refetch the parent
  // session so buildEndedAt propagates without waiting for navigation.
  useEffect(() => {
    if (summaryQuery.data?.buildEndedAt) {
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
    }
  }, [summaryQuery.data?.buildEndedAt, queryClient, session.id]);

  const inProgress = !!session.buildStartedAt && !session.buildEndedAt;
  const finished = !!session.buildEndedAt;

  return (
    <section>
      <h3 className="text-xs font-medium text-gray-700 uppercase tracking-wide mb-2">
        Build phase
      </h3>

      {!session.buildStartedAt && (
        <NotStartedCard
          onStart={() => startMutation.mutate()}
          loading={startMutation.isPending}
          error={startMutation.isError ? extractApiError(startMutation.error) : null}
        />
      )}

      {inProgress && (
        <InProgressCard
          session={session}
          token={issuedToken}
          buildStartedAtIso={issuedBuildStartedAt}
          summary={summaryQuery.data ?? null}
          summaryLoading={summaryQuery.isLoading}
          onRotate={() => startMutation.mutate()}
          rotating={startMutation.isPending}
          rotateError={startMutation.isError ? extractApiError(startMutation.error) : null}
        />
      )}

      {finished && summaryQuery.data && (
        <CompleteCard session={session} summary={summaryQuery.data} />
      )}
    </section>
  );
}

function NotStartedCard({
  onStart,
  loading,
  error,
}: {
  onStart: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded border border-blue-200 bg-blue-50/40 p-3">
      <div className="text-sm text-gray-800 mb-2">
        Capture your build live. Run a watcher in your project directory while
        you implement the plan; we'll record file saves and use them to score
        the build phase.
      </div>
      <div className="text-[11px] text-gray-600 mb-2 leading-snug">
        We also read your Claude Code conversation logs for this project (the
        files in <code className="font-mono">~/.claude/projects/</code>) so we
        can see how you navigated the AI during the build, not just the final
        files. Only sessions that start after you click below are included; we
        skip prior chats on the same project. Pass{' '}
        <code className="font-mono">--no-ai-logs</code> to opt out.
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={loading}
        className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {loading ? 'Minting token…' : 'Start build phase'}
      </button>
      {error && (
        <div className="mt-2 text-xs text-red-700">
          Could not start build phase: {error}
        </div>
      )}
    </div>
  );
}

function InProgressCard({
  session,
  token,
  buildStartedAtIso,
  summary,
  summaryLoading,
  onRotate,
  rotating,
  rotateError,
}: {
  session: Session;
  token: string | null;
  buildStartedAtIso: string | null;
  summary: BuildEventsSummary | null;
  summaryLoading: boolean;
  onRotate: () => void;
  rotating: boolean;
  rotateError: string | null;
}) {
  const eventCount = summary?.eventCount ?? session.buildEventCount;
  const fileCount = summary?.perFile.length;
  const aiCount = summary?.aiInteractionCount ?? 0;
  const aiSessions = summary?.aiSessionsCount ?? 0;
  const stage = eventCount === 0 ? 'waiting' : 'in-progress';

  return (
    <div className="rounded border border-blue-200 bg-blue-50/40 p-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        <span className="text-sm font-medium text-gray-800">
          {stage === 'waiting'
            ? 'Waiting for the watcher to capture events…'
            : 'Capturing your build…'}
        </span>
        <span className="text-[11px] text-gray-500">
          {summaryLoading && fileCount === undefined
            ? 'loading…'
            : `${fileCount ?? 0} file${(fileCount ?? 0) === 1 ? '' : 's'} · ${eventCount} event${eventCount === 1 ? '' : 's'}`}
        </span>
        {aiCount > 0 && (
          <span className="text-[11px] text-gray-500">
            · {aiCount} AI turn{aiCount === 1 ? '' : 's'} across {aiSessions}{' '}
            session{aiSessions === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {token ? (
        <InstallCommand token={token} buildStartedAtIso={buildStartedAtIso} />
      ) : (
        <div className="rounded border border-gray-200 bg-white p-2 text-[11px] text-gray-700">
          <p className="mb-1">
            Build started already, but the install command isn't on this
            page anymore (we don't store the token in the browser).
          </p>
          <p className="mb-2">
            If your watcher is still running, you don't need to do anything.
            Otherwise, re-mint the token to get a fresh install command —
            this rotates the secret, so any previously running watcher will
            stop being able to flush.
          </p>
          <button
            type="button"
            onClick={onRotate}
            disabled={rotating}
            className="rounded border border-blue-300 bg-white text-blue-700 px-2 py-1 text-[11px] font-medium hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rotating ? 'Rotating…' : 'Re-mint token'}
          </button>
          {rotateError && (
            <div className="mt-1 text-red-700">Could not rotate: {rotateError}</div>
          )}
        </div>
      )}
    </div>
  );
}

function InstallCommand({
  token,
  buildStartedAtIso,
}: {
  token: string;
  buildStartedAtIso: string | null;
}) {
  const [copied, setCopied] = useState(false);
  // Pass --build-started-at so the watcher filters Claude Code log
  // sessions whose first turn predates this build phase.
  const watchFlags = buildStartedAtIso
    ? `--build-started-at ${buildStartedAtIso}`
    : '';
  const command = `cd cli && npm install && npm run build && npm link  # one-time
mentor watch ${token}${watchFlags ? ` ${watchFlags}` : ''}`;

  const copy = () => {
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wide text-gray-600">
          Run this on your machine, in your project directory
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-[11px] text-blue-700 hover:underline"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="rounded border border-gray-300 bg-gray-900 text-gray-100 p-2 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto select-all">
        {command}
      </pre>
      <div className="mt-1 text-[11px] text-gray-500">
        Token expires in 60 minutes. Closing the watcher (Ctrl-C or
        <code className="font-mono mx-1">mentor finish</code>) finalizes the
        build phase.
      </div>
    </div>
  );
}

function CompleteCard({
  session,
  summary,
}: {
  session: Session;
  summary: BuildEventsSummary;
}) {
  const [open, setOpen] = useState(false);
  const durationMin = computeDurationMinutes(session);
  return (
    <div className="rounded border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-sm font-medium text-emerald-900">
          Build phase complete
        </span>
        <span className="text-[11px] text-gray-600 tabular-nums">
          {summary.eventCount} event{summary.eventCount === 1 ? '' : 's'} · {summary.perFile.length} file{summary.perFile.length === 1 ? '' : 's'}
          {durationMin !== null && ` · ${durationMin} min`}
        </span>
      </div>
      {summary.aiInteractionCount > 0 && (
        <div className="text-[11px] text-gray-700">
          AI conversations captured:{' '}
          <span className="tabular-nums">
            {summary.aiInteractionCount} turn{summary.aiInteractionCount === 1 ? '' : 's'} across{' '}
            {summary.aiSessionsCount} session{summary.aiSessionsCount === 1 ? '' : 's'}
          </span>
        </div>
      )}
      <div className="text-[11px] text-gray-500">
        Build evaluation runs with phase 4 (BuildAgent). For now, the captured
        timeline is below.
      </div>
      {summary.perFile.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-blue-700 hover:underline"
            aria-expanded={open}
          >
            {open ? '▼' : '▶'} Per-file timeline ({summary.perFile.length})
          </button>
          {open && (
            <div className="mt-2 rounded border border-gray-200 bg-white divide-y divide-gray-100">
              {summary.perFile.map((f) => (
                <div
                  key={f.filePath}
                  className="px-2 py-1.5 flex items-center gap-3 text-xs"
                >
                  <span className="font-mono text-gray-800 flex-1 truncate">
                    {f.filePath}
                  </span>
                  <span className="tabular-nums text-gray-600">
                    {f.eventCount} event{f.eventCount === 1 ? '' : 's'}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {formatRange(f.firstAt, f.lastAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function computeDurationMinutes(session: Session): number | null {
  if (!session.buildStartedAt || !session.buildEndedAt) return null;
  const start = new Date(session.buildStartedAt).getTime();
  const end = new Date(session.buildEndedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function formatRange(firstAt: string | null, lastAt: string | null): string {
  if (!firstAt) return '';
  if (!lastAt || firstAt === lastAt) return new Date(firstAt).toLocaleTimeString();
  return `${new Date(firstAt).toLocaleTimeString()} → ${new Date(lastAt).toLocaleTimeString()}`;
}
