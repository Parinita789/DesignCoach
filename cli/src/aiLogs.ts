import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type AITurnRole = 'user' | 'assistant' | 'tool_use' | 'tool_result';

export interface NormalizedAITurn {
  tool: 'claude-code';
  externalSessionId: string;
  turnIndex: number;
  occurredAt: string;
  role: AITurnRole;
  text: string | null;
  toolName: string | null;
  toolInputSummary: string | null;
  toolResultSummary: string | null;
}

// Truncation thresholds — kept as module constants so tests + UI docs
// can reference the same numbers. Aggressive on tool input/result so a
// `Read` of a 50KB file doesn't dominate the wire payload.
export const TEXT_CAP = 4096;
export const TOOL_INPUT_CAP = 200;
export const TOOL_RESULT_CAP = 1024;

export function encodedCwd(cwd: string): string {
  // Claude Code's convention: take the absolute path, replace each `/`
  // with `-`. The leading slash becomes a leading `-`.
  return cwd.replace(/\//g, '-');
}

export function claudeProjectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodedCwd(cwd));
}

interface CursorEntry {
  byteOffset: number;
  // 'skip' marks files we've already decided are pre-build sessions.
  skip?: true;
}

interface CursorFile {
  cursors: Record<string, CursorEntry>;
}

const DEFAULT_CURSOR_DIR = path.join(os.homedir(), '.mentor');
const CURSOR_FILE = 'ai-cursor.json';

export interface ClaudeCodeLogReaderOptions {
  cwd: string;
  buildStartedAt: Date;
  cursorDir?: string;
  // Allow tests to override the project-dir computation rather than
  // mocking os.homedir() — simpler.
  projectDirOverride?: string;
}

// Reads new turns from Claude Code's per-project JSONL session files.
// Stateful via ~/.mentor/ai-cursor.json so re-invocation only ships
// genuinely new lines.
export class ClaudeCodeLogReader {
  private projectDir: string;
  private cursorPath: string;
  private buildStartedAtMs: number;

  constructor(private readonly opts: ClaudeCodeLogReaderOptions) {
    this.projectDir = opts.projectDirOverride ?? claudeProjectDir(opts.cwd);
    const dir = opts.cursorDir ?? DEFAULT_CURSOR_DIR;
    fs.mkdirSync(dir, { recursive: true });
    this.cursorPath = path.join(dir, CURSOR_FILE);
    this.buildStartedAtMs = opts.buildStartedAt.getTime();
  }

  // Returns ALL new turns across every session JSONL file in the
  // project's encoded-cwd dir since the last scan. Empty array if
  // the project has never used Claude Code.
  async scan(): Promise<NormalizedAITurn[]> {
    if (!fs.existsSync(this.projectDir)) return [];
    const cursors = this.readCursors();
    const out: NormalizedAITurn[] = [];

    let dirEntries: string[];
    try {
      dirEntries = fs.readdirSync(this.projectDir);
    } catch {
      return [];
    }

    for (const name of dirEntries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.projectDir, name);
      const externalSessionId = name.replace(/\.jsonl$/, '');
      const cursor = cursors.cursors[file];
      if (cursor?.skip) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }

      // First time we see this file — decide if it's a pre-build session
      // and, if so, mark it skip so we never re-evaluate.
      if (!cursor) {
        const firstTurnAt = peekFirstTurnTimestamp(file);
        if (firstTurnAt !== null && firstTurnAt < this.buildStartedAtMs) {
          cursors.cursors[file] = { byteOffset: stat.size, skip: true };
          continue;
        }
        cursors.cursors[file] = { byteOffset: 0 };
      }

      const startOffset = cursors.cursors[file].byteOffset;
      if (stat.size <= startOffset) continue;

      const fd = fs.openSync(file, 'r');
      try {
        const length = stat.size - startOffset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, startOffset);
        const text = buf.toString('utf-8');
        const lines = text.split('\n');
        // The trailing element is either '' (clean newline-terminated)
        // or a partial line. Either way, don't try to parse it; advance
        // the cursor only past the last newline we saw.
        const completeLines = lines.slice(0, -1);
        const lastNewlineEnd = startOffset + Buffer.byteLength(
          completeLines.join('\n') + (completeLines.length > 0 ? '\n' : ''),
          'utf-8',
        );

        const baseIndex = countLinesBefore(file, startOffset);
        for (let i = 0; i < completeLines.length; i++) {
          const turn = parseClaudeCodeLine(
            completeLines[i],
            externalSessionId,
            baseIndex + i,
          );
          if (turn) out.push(turn);
        }
        cursors.cursors[file].byteOffset = lastNewlineEnd;
      } finally {
        fs.closeSync(fd);
      }
    }

    this.writeCursors(cursors);
    return out;
  }

  cursorPathForTests(): string {
    return this.cursorPath;
  }

  private readCursors(): CursorFile {
    if (!fs.existsSync(this.cursorPath)) return { cursors: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorPath, 'utf-8')) as CursorFile;
      if (!parsed?.cursors) return { cursors: {} };
      return parsed;
    } catch {
      return { cursors: {} };
    }
  }

  private writeCursors(state: CursorFile): void {
    fs.writeFileSync(this.cursorPath, JSON.stringify(state), 'utf-8');
  }
}

// Reads the first `\n`-delimited line of the file and pulls a timestamp
// off it. Returns null when the file is empty or malformed.
function peekFirstTurnTimestamp(file: string): number | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const slice = buf.subarray(0, read).toString('utf-8');
      const newline = slice.indexOf('\n');
      const line = newline >= 0 ? slice.slice(0, newline) : slice;
      const parsed = JSON.parse(line);
      const ts = (parsed as { timestamp?: string }).timestamp;
      if (typeof ts !== 'string') return null;
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// We need turnIndex to be stable across CLI restarts. Counting newlines
// in the bytes BEFORE the cursor gives us "how many turns came before
// this batch" — which is exactly the right index for the new turns.
function countLinesBefore(file: string, byteOffset: number): number {
  if (byteOffset === 0) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(byteOffset);
    fs.readSync(fd, buf, 0, byteOffset, 0);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    return count;
  } finally {
    fs.closeSync(fd);
  }
}

interface RawClaudeCodeLine {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

// Maps a single JSONL line into the normalized event shape, applying
// truncation. Returns null for lines we can't make sense of (parser
// version mismatch, malformed content). Caller logs / drops.
export function parseClaudeCodeLine(
  raw: string,
  externalSessionId: string,
  turnIndex: number,
): NormalizedAITurn | null {
  let parsed: RawClaudeCodeLine;
  try {
    parsed = JSON.parse(raw) as RawClaudeCodeLine;
  } catch {
    return null;
  }
  const occurredAt = parsed.timestamp ?? new Date(0).toISOString();
  const top = parsed.type;
  const inner = parsed.message?.role;
  const role = chooseRole(top, inner, parsed.message?.content);
  if (!role) return null;

  const base: NormalizedAITurn = {
    tool: 'claude-code',
    externalSessionId,
    turnIndex,
    occurredAt,
    role,
    text: null,
    toolName: null,
    toolInputSummary: null,
    toolResultSummary: null,
  };

  const content = parsed.message?.content;
  if (typeof content === 'string') {
    base.text = truncate(content, TEXT_CAP);
    return base;
  }
  if (!Array.isArray(content)) return base;

  // Claude Code stores each turn as one or more content blocks. Walk
  // them; if we see tool_use or tool_result we promote the role
  // accordingly so the row's role reflects the dominant action.
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      base.text = base.text === null ? truncate(b.text, TEXT_CAP) : base.text;
    } else if (b.type === 'tool_use') {
      base.role = 'tool_use';
      base.toolName = typeof b.name === 'string' ? b.name : null;
      base.toolInputSummary = summarizeToolInput(b.name, b.input);
    } else if (b.type === 'tool_result') {
      base.role = 'tool_result';
      base.toolResultSummary = truncate(stringifyResult(b.content), TOOL_RESULT_CAP);
    }
  }
  return base;
}

function chooseRole(
  top: string | undefined,
  inner: string | undefined,
  content: unknown,
): AITurnRole | null {
  // Claude Code's transcripts use `type: 'user' | 'assistant'` at the
  // top level and the message.role mirrors that. Tool turns are
  // detected by content-block inspection in the caller.
  const fromInner = (inner === 'user' || inner === 'assistant') ? inner : null;
  const fromTop = (top === 'user' || top === 'assistant') ? top : null;
  const role = fromInner ?? fromTop;
  if (!role) {
    // Some lines (summaries, env metadata) don't have role — skip.
    return null;
  }
  // If the content is purely a tool_result block, present as tool_result.
  if (Array.isArray(content)) {
    const hasOnlyToolResults = content.every(
      (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
    );
    if (hasOnlyToolResults) return 'tool_result';
  }
  return role;
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const dropped = s.length - cap;
  return s.slice(0, cap) + ` [+ ${dropped} chars truncated]`;
}

function summarizeToolInput(name: string | undefined, input: unknown): string {
  if (!name) return '';
  const i = input as Record<string, unknown> | undefined;
  switch (name) {
    case 'Read': {
      const p = typeof i?.file_path === 'string' ? i.file_path : '?';
      return `read ${truncate(p, TOOL_INPUT_CAP)}`;
    }
    case 'Edit':
    case 'Write': {
      const p = typeof i?.file_path === 'string' ? i.file_path : '?';
      return `${name.toLowerCase()} ${truncate(p, TOOL_INPUT_CAP)}`;
    }
    case 'Bash': {
      const cmd = typeof i?.command === 'string' ? i.command : '?';
      return `bash | ${truncate(cmd, TOOL_INPUT_CAP)}`;
    }
    case 'WebFetch': {
      const url = typeof i?.url === 'string' ? i.url : '?';
      return `webfetch ${truncate(url, TOOL_INPUT_CAP)}`;
    }
    case 'Grep':
    case 'Glob': {
      const pat = typeof i?.pattern === 'string' ? i.pattern : '?';
      return `${name.toLowerCase()} ${truncate(pat, TOOL_INPUT_CAP)}`;
    }
    default: {
      const json = (() => {
        try {
          return JSON.stringify(input);
        } catch {
          return '?';
        }
      })();
      return `${name} ${truncate(json, TOOL_INPUT_CAP)}`;
    }
  }
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return '?';
  }
}
