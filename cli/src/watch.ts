import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar from 'chokidar';
import chalk from 'chalk';
import ignore, { Ignore } from 'ignore';
import { EventBuffer, NewEvent } from './buffer';
import { AIBuffer } from './aiBuffer';
import { ClaudeCodeLogReader } from './aiLogs';
import { computeChange, isNoopOutcome, PrevState } from './diff';
import {
  drainAiBuffer,
  drainBuffer,
  MentorApiClient,
  sendAiWithBackoff,
  sendWithBackoff,
} from './api';
import { readState, writeSession, writeState } from './config';

export interface WatchOptions {
  token: string;
  cwd: string;
  server: string;
  durationMinutes: number;
  captureAiLogs: boolean;
  // ISO8601 from the start-build response when available. Used to filter
  // out Claude Code sessions that predate the build phase.
  buildStartedAtIso?: string;
}

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_BATCH_SIZE = 100;
const ELAPSED_TICK_MS = 5 * 60_000;

const HARD_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.DS_Store',
  '*.log',
];

export async function runWatch(opts: WatchOptions): Promise<void> {
  const cwd = path.resolve(opts.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`watch: cwd does not exist or is not a directory: ${cwd}`);
  }

  writeSession({
    token: opts.token,
    server: opts.server,
    buildStartedAt: opts.buildStartedAtIso,
  });
  writeState({ ...readState(), startedAt: new Date().toISOString() });

  const buffer = new EventBuffer();
  const aiBuffer = new AIBuffer();
  const api = new MentorApiClient({ token: opts.token, server: opts.server });
  const ig = loadIgnore(cwd);
  const prev = new Map<string, PrevState>();

  const buildStartedAt = opts.buildStartedAtIso
    ? new Date(opts.buildStartedAtIso)
    : new Date();
  const aiReader = opts.captureAiLogs
    ? new ClaudeCodeLogReader({ cwd, buildStartedAt })
    : null;

  const watcher = chokidar.watch(cwd, {
    persistent: true,
    ignoreInitial: true,
    ignored: (p: string) => isIgnored(p, cwd, ig),
  });

  const onChange = async (
    absPath: string,
    action: 'add' | 'change' | 'unlink',
  ): Promise<void> => {
    const rel = path.relative(cwd, absPath);
    if (!rel || rel.startsWith('..')) return;
    if (action === 'unlink') {
      buffer.append({ filePath: rel, action: 'deleted' });
      prev.delete(rel);
      return;
    }
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (err) {
      console.warn(chalk.yellow(`mentor: failed to read ${rel}: ${(err as Error).message}`));
      return;
    }
    const outcome = computeChange(rel, prev.get(rel) ?? null, content);
    if (isNoopOutcome(outcome)) {
      // File was touched (mtime bump, save with no edits) but content
      // is unchanged. Update prev's capturedAt so re-baselining still
      // tracks freshness, but don't append a phantom event.
      const p = prev.get(rel);
      if (p) p.capturedAt = Date.now();
      return;
    }
    const evt: NewEvent = {
      filePath: rel,
      action: outcome.action,
      content: outcome.content,
      contentDiff: outcome.contentDiff,
    };
    buffer.append(evt);
    prev.set(rel, { content, capturedAt: Date.now() });
    if (buffer.unsent().length >= FLUSH_BATCH_SIZE) {
      void flush();
    }
  };

  watcher.on('add', (p: string) => onChange(p, 'add'));
  watcher.on('change', (p: string) => onChange(p, 'change'));
  watcher.on('unlink', (p: string) => onChange(p, 'unlink'));
  watcher.on('error', (err: unknown) =>
    console.error(chalk.red(`mentor: watcher error: ${(err as Error).message}`)),
  );

  console.log(chalk.cyan(`mentor: watching ${cwd}`));
  console.log(
    chalk.gray(
      `mentor: server ${opts.server} · duration ${opts.durationMinutes}m · ai-logs ${
        opts.captureAiLogs ? 'on' : 'off'
      }`,
    ),
  );

  let shutdown = false;

  // Scan Claude Code's project log dir, append any new turns to the AI
  // buffer. Returns turn count newly buffered (not flushed).
  const scanAi = async (): Promise<number> => {
    if (!aiReader) return 0;
    try {
      const turns = await aiReader.scan();
      for (const t of turns) aiBuffer.append(t);
      return turns.length;
    } catch (err) {
      console.warn(
        chalk.yellow(`mentor: ai-log scan failed: ${(err as Error).message}`),
      );
      return 0;
    }
  };

  const flush = async (): Promise<void> => {
    if (shutdown) return;
    await scanAi();
    const events = buffer.unsent(FLUSH_BATCH_SIZE);
    if (events.length > 0) {
      const out = await sendWithBackoff(api, events);
      if (out.ok) {
        buffer.markSent(events.map((e) => e.id));
        writeState({ ...readState(), lastFlushAt: new Date().toISOString(), lastFlushOk: true });
        console.log(chalk.gray(`mentor: flushed ${out.accepted} events`));
      } else {
        writeState({
          ...readState(),
          lastFlushAt: new Date().toISOString(),
          lastFlushOk: false,
          lastFlushError: out.error,
        });
        console.warn(chalk.yellow(`mentor: flush failed (${out.error}); will retry`));
      }
    }
    const aiTurns = aiBuffer.unsent(FLUSH_BATCH_SIZE);
    if (aiTurns.length > 0) {
      const out = await sendAiWithBackoff(api, aiTurns);
      if (out.ok) {
        aiBuffer.markSent(aiTurns.map((t) => t.id));
        console.log(chalk.gray(`mentor: flushed ${out.accepted} AI turns`));
      } else {
        console.warn(chalk.yellow(`mentor: ai flush failed (${out.error}); will retry`));
      }
    }
  };

  const flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  const startedAt = Date.now();
  const elapsedTimer = setInterval(() => {
    const min = Math.round((Date.now() - startedAt) / 60_000);
    const { total, unsent } = buffer.size();
    const ai = aiBuffer.size();
    const aiPart = aiReader
      ? ` · ${ai.total} AI turns (${ai.unsent} unsent)`
      : '';
    console.log(
      chalk.gray(
        `mentor: ${min}m elapsed · ${total} events captured · ${unsent} unsent${aiPart}`,
      ),
    );
  }, ELAPSED_TICK_MS);

  const finalize = async (reason: string): Promise<void> => {
    if (shutdown) return;
    shutdown = true;
    clearInterval(flushTimer);
    clearInterval(elapsedTimer);
    console.log(chalk.cyan(`mentor: shutting down (${reason})`));
    await watcher.close();

    // One last AI scan so any turns that landed between the last
    // periodic scan and shutdown also get drained.
    await scanAi();

    // Final flush — chunked so a long build's tail doesn't ship as
    // one huge body (would hit timeouts / size caps).
    const drain = await drainBuffer(api, buffer, FLUSH_BATCH_SIZE);
    if (drain.error) {
      console.warn(
        chalk.yellow(
          `mentor: final flush partial — ${drain.flushed} sent, ` +
            `${drain.remaining} unsent (${drain.error})`,
        ),
      );
    }

    const aiDrain = await drainAiBuffer(api, aiBuffer, FLUSH_BATCH_SIZE);
    if (aiDrain.error) {
      console.warn(
        chalk.yellow(
          `mentor: final ai flush partial — ${aiDrain.flushed} sent, ` +
            `${aiDrain.remaining} unsent (${aiDrain.error})`,
        ),
      );
    }

    let finishOk = false;
    try {
      await api.finishBuild();
      finishOk = true;
    } catch (err) {
      console.warn(chalk.yellow(`mentor: finish call failed: ${(err as Error).message}`));
    }

    const { total, unsent } = buffer.size();
    const ai = aiBuffer.size();
    const sec = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      chalk.cyan(
        `mentor: done · ${total} events · ${total - unsent} flushed · ${unsent} unsent · ${sec}s`,
      ),
    );
    if (aiReader) {
      console.log(
        chalk.cyan(
          `mentor: ai · ${ai.total} turns · ${ai.total - ai.unsent} flushed · ${ai.unsent} unsent`,
        ),
      );
    }
    const cleanExit = finishOk && unsent === 0 && ai.unsent === 0;
    process.exit(cleanExit ? 0 : 1);
  };

  process.once('SIGINT', () => void finalize('SIGINT'));
  process.once('SIGTERM', () => void finalize('SIGTERM'));
  setTimeout(() => void finalize('duration timer'), opts.durationMinutes * 60_000);

  // Block forever — chokidar + timers keep the loop alive.
  await new Promise(() => {});
}

function loadIgnore(cwd: string): Ignore {
  const ig = ignore();
  ig.add(HARD_IGNORE);
  const gitignore = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignore)) {
    try {
      ig.add(fs.readFileSync(gitignore, 'utf-8'));
    } catch {
      // ignore
    }
  }
  return ig;
}

function isIgnored(absPath: string, cwd: string, ig: Ignore): boolean {
  const rel = path.relative(cwd, absPath);
  if (!rel || rel === '') return false;
  if (rel.startsWith('..')) return true;
  return ig.ignores(rel);
}
