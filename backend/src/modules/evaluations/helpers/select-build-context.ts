import { BuildContext } from '../types/evaluation.types';

const TOP_KEY_FILES = 5;
const KEY_FILE_MAX_CHARS = 4000;
const RECENT_AI_TURNS = 40;
const AI_TEXT_CAP = 2000;

interface RawEvent {
  filePath: string;
  action: string;
  contentDiff: string | null;
  occurredAt: Date;
}

interface RawAiTurn {
  externalSessionId: string;
  turnIndex: number;
  role: string;
  text: string | null;
  toolName: string | null;
  toolInputSummary: string | null;
  toolResultSummary: string | null;
  occurredAt: Date;
}

// Pick which file snippets get rendered verbatim into the eval prompt and
// which AI turns get included. Sized so a heavy build session stays
// comfortably under the 100K-token prompt budget.
export function selectBuildContext(args: {
  events: RawEvent[];
  aiTurns: RawAiTurn[];
  contents: Map<string, string>;
}): {
  keyFileSnippets: BuildContext['keyFileSnippets'];
  aiTurnsForPrompt: BuildContext['aiTurns'];
} {
  const churnByPath = new Map<string, number>();
  for (const e of args.events) {
    if (!e.contentDiff) continue;
    churnByPath.set(e.filePath, (churnByPath.get(e.filePath) ?? 0) + e.contentDiff.length);
  }

  const ranked = [...args.contents.keys()]
    .map((path) => ({ path, churn: churnByPath.get(path) ?? 0 }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, TOP_KEY_FILES);

  const keyFileSnippets = ranked.map(({ path }) => {
    const full = args.contents.get(path) ?? '';
    const content =
      full.length <= KEY_FILE_MAX_CHARS
        ? full
        : full.slice(0, KEY_FILE_MAX_CHARS) + `\n... [truncated, ${full.length - KEY_FILE_MAX_CHARS} chars omitted]`;
    return { path, content };
  });

  const sortedAi = [...args.aiTurns].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
  const recent = sortedAi.slice(0, RECENT_AI_TURNS).reverse();
  const aiTurnsForPrompt: BuildContext['aiTurns'] = recent.map((t) => ({
    externalSessionId: t.externalSessionId,
    turnIndex: t.turnIndex,
    role: normaliseRole(t.role),
    text: t.text === null ? null : capText(t.text, AI_TEXT_CAP),
    toolName: t.toolName,
    toolInputSummary: t.toolInputSummary,
    toolResultSummary: t.toolResultSummary,
    occurredAt: t.occurredAt,
  }));

  return { keyFileSnippets, aiTurnsForPrompt };
}

function normaliseRole(role: string): 'user' | 'assistant' | 'tool' {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role;
  return 'tool';
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `... [truncated ${text.length - cap} chars]`;
}
