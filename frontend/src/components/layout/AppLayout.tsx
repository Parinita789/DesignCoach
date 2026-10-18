import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useMatch, useNavigate } from 'react-router-dom';
import { DailySpendBadge } from '@components/layout/DailySpendBadge';
import { useAuthStore } from '@/store/authStore';
import { ThemeMode, useThemeStore } from '@/store/themeStore';
import { questionsService } from '@/services/questions.service';
import { QuestionWithSessions } from '@/types/question';

const SIDEBAR_COLLAPSED_KEY = 'app-sidebar-collapsed';

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const homeMatch = useMatch('/home');
  const questionMatch = useMatch('/questions/:id');
  const newPracticeMatch = useMatch('/practice/new');
  const feedbackMatch = useMatch('/feedback');
  const drillsMatch = useMatch('/drills');
  const activeSessionMatch = useMatch('/sessions/:id/active');
  const isQuestionsActive = !!homeMatch || !!questionMatch || !!newPracticeMatch;
  const isFeedbackActive = !!feedbackMatch;
  const isDrillsActive = !!drillsMatch;
  const currentUser = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const questionsQuery = useQuery({
    queryKey: ['questions'],
    queryFn: () => questionsService.list(),
    staleTime: 30_000,
  });
  const latestActiveSession = findLatestActiveSession(questionsQuery.data ?? []);
  const activeSessionHref = latestActiveSession
    ? `/sessions/${latestActiveSession.id}/active`
    : activeSessionMatch?.params.id
      ? `/sessions/${activeSessionMatch.params.id}/active`
      : null;
  const isActiveSessionActive = !!activeSessionMatch;
  const isDark = themeMode === 'dark';

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', themeMode === 'dark');
    root.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    if (!profileOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (profileMenuRef.current?.contains(event.target as Node)) return;
      setProfileOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [profileOpen]);

  const onLogout = () => {
    clearAuth();
    queryClient.clear();
    setProfileOpen(false);
    navigate('/login', { replace: true });
  };

  return (
    <div
      className={`flex h-screen flex-col ${
        isDark ? 'bg-slate-950 text-slate-100' : 'bg-gray-50 text-gray-950'
      }`}
    >
      <header
        className={`flex h-14 shrink-0 items-center justify-between border-b px-4 ${
          isDark ? 'border-slate-800 bg-slate-950' : 'border-gray-200 bg-white'
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/home" className="flex min-w-0 items-center gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold shadow-sm ring-2 ${
                isDark
                  ? 'bg-slate-900 text-teal-100 ring-teal-400/25'
                  : 'bg-teal-700 text-white ring-teal-500/20'
              }`}
            >
              DC
            </span>
            <span
              className={`truncate text-base font-semibold ${
                isDark ? 'text-slate-100' : 'text-gray-950'
              }`}
            >
              Design Coach
            </span>
          </Link>
        </div>

        <div className="flex min-w-0 items-center gap-3">
          {currentUser && (
            <div ref={profileMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                className={`flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 ${
                  isDark ? 'hover:bg-slate-900' : 'hover:bg-gray-100'
                }`}
              >
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase ${
                    isDark ? 'bg-teal-500 text-slate-950' : 'bg-teal-700 text-white'
                  }`}
                >
                  {(currentUser.displayName || currentUser.email).slice(0, 1)}
                </div>
                <div className="hidden min-w-0 text-left sm:block">
                  <div
                    className={`truncate text-sm font-medium ${
                      isDark ? 'text-slate-100' : 'text-gray-950'
                    }`}
                  >
                    {currentUser.displayName || currentUser.email}
                  </div>
                  <div
                    className={`truncate text-xs ${isDark ? 'text-slate-400' : 'text-gray-500'}`}
                  >
                    {currentUser.email}
                  </div>
                </div>
              </button>

              {profileOpen && (
                <div
                  role="menu"
                  className={`absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-lg border shadow-xl ${
                    isDark ? 'border-slate-800 bg-slate-950' : 'border-gray-200 bg-white'
                  }`}
                >
                  <div
                    className={`px-4 py-4 ${
                      isDark
                        ? 'bg-gradient-to-r from-gray-950 to-teal-900 text-white'
                        : 'bg-gradient-to-r from-teal-50 to-white text-gray-950'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase ring-1 ${
                          isDark
                            ? 'bg-white/15 text-white ring-white/25'
                            : 'bg-teal-700 text-white ring-teal-100'
                        }`}
                      >
                        {(currentUser.displayName || currentUser.email).slice(0, 1)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">
                          {currentUser.displayName || currentUser.email}
                        </div>
                        <div
                          className={`truncate text-xs ${
                            isDark ? 'text-teal-100' : 'text-teal-800'
                          }`}
                        >
                          {currentUser.email}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="p-3">
                    <DailySpendBadge variant="menu" />
                    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-slate-800">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
                        Settings
                      </div>
                      <ThemeSegmentedControl value={themeMode} onChange={setThemeMode} />
                    </div>
                    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-slate-800">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={onLogout}
                        className="flex h-9 w-full items-center justify-center rounded-md bg-rose-50 px-3 text-sm font-semibold text-rose-700 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20"
                      >
                        Logout
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`relative shrink-0 border-r transition-[width] duration-150 ease-in-out ${
            collapsed ? 'w-12' : 'w-60'
          } ${isDark ? 'border-slate-800 bg-slate-950' : 'border-gray-200 bg-white'}`}
        >
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`absolute top-4 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border shadow-sm ${
              collapsed ? '-right-4' : '-right-4'
            } ${
              isDark
                ? 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-white'
                : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-900'
            }`}
          >
            <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
          </button>
          <nav className="p-2">
            <div className="space-y-1">
              <Link
                to="/home"
                title="Questions"
                aria-label="Questions"
                className={`flex h-9 items-center rounded-md text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center px-0' : 'gap-2 px-3'
                } ${
                  isQuestionsActive
                    ? isDark
                      ? 'bg-slate-900 text-white'
                      : 'bg-teal-700 text-white'
                    : isDark
                      ? 'text-slate-300 hover:bg-slate-900 hover:text-white'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-semibold ${
                    isQuestionsActive
                      ? 'bg-white/15 text-white'
                      : isDark
                        ? 'bg-slate-800 text-slate-200'
                        : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  📚
                </span>
                {!collapsed && <span>Questions</span>}
              </Link>
              {activeSessionHref && (
                <Link
                  to={activeSessionHref}
                  title="Active Session"
                  aria-label="Active Session"
                  className={`flex h-9 items-center rounded-md text-sm font-medium transition-colors ${
                    collapsed ? 'justify-center px-0' : 'gap-2 px-3'
                  } ${
                    isActiveSessionActive
                      ? isDark
                        ? 'bg-slate-900 text-white'
                        : 'bg-teal-700 text-white'
                      : isDark
                        ? 'text-slate-300 hover:bg-slate-900 hover:text-white'
                        : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-semibold ${
                      isActiveSessionActive
                        ? 'bg-white/15 text-white'
                        : isDark
                          ? 'bg-teal-400/10 text-teal-200'
                          : 'bg-teal-100 text-teal-800'
                    }`}
                  >
                    🟢
                  </span>
                  {!collapsed && (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      <span className="truncate">Active Session</span>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    </span>
                  )}
                </Link>
              )}
              <Link
                to="/feedback"
                title="Feedback"
                aria-label="Feedback"
                className={`flex h-9 items-center rounded-md text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center px-0' : 'gap-2 px-3'
                } ${
                  isFeedbackActive
                    ? isDark
                      ? 'bg-slate-900 text-white'
                      : 'bg-teal-700 text-white'
                    : isDark
                      ? 'text-slate-300 hover:bg-slate-900 hover:text-white'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-semibold ${
                    isFeedbackActive
                      ? 'bg-white/15 text-white'
                      : isDark
                        ? 'bg-slate-800 text-slate-200'
                        : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  💬
                </span>
                {!collapsed && <span>Feedback</span>}
              </Link>
              <Link
                to="/drills"
                title="Pattern Drill"
                aria-label="Pattern Drill"
                className={`flex h-9 items-center rounded-md text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center px-0' : 'gap-2 px-3'
                } ${
                  isDrillsActive
                    ? isDark
                      ? 'bg-slate-900 text-white'
                      : 'bg-teal-700 text-white'
                    : isDark
                      ? 'text-slate-300 hover:bg-slate-900 hover:text-white'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-semibold ${
                    isDrillsActive
                      ? 'bg-white/15 text-white'
                      : isDark
                        ? 'bg-slate-800 text-slate-200'
                        : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  🧩
                </span>
                {!collapsed && <span>Pattern Drill</span>}
              </Link>
            </div>
          </nav>
        </aside>

        <main
          className={`min-h-0 flex-1 overflow-y-auto px-4 py-4 ${
            isDark ? 'bg-slate-950' : 'bg-gray-50'
          }`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ThemeSegmentedControl({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  const options: Array<{ value: ThemeMode; label: string; icon: string }> = [
    { value: 'light', label: 'Light', icon: '☀️' },
    { value: 'dark', label: 'Dark', icon: '🌙' },
  ];

  return (
    <div className="grid grid-cols-2 gap-1 rounded-md border border-gray-200 bg-gray-50 p-1 dark:border-slate-800 dark:bg-slate-900">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded text-xs font-semibold transition-colors ${
            value === option.value
              ? 'bg-white text-gray-950 shadow-sm dark:bg-teal-500 dark:text-slate-950'
              : 'text-gray-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
        >
          <span aria-hidden="true">{option.icon}</span>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function findLatestActiveSession(questions: QuestionWithSessions[]) {
  return (
    questions
      .flatMap((question) =>
        question.sessions
          .filter((session) => session.status === 'active')
          .map((session) => ({
            id: session.id,
            startedAt: session.startedAt,
          })),
      )
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ??
    null
  );
}
