import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_DIR = path.join(os.homedir(), '.mentor');
const SESSION_FILE = path.join(DEFAULT_DIR, 'session.json');
const STATE_FILE = path.join(DEFAULT_DIR, 'state.json');

export interface SessionConfig {
  token: string;
  server: string;
  // ISO8601. Captured from the start-build response so the AI-log
  // reader can filter pre-build Claude Code sessions on this project.
  buildStartedAt?: string;
}

export interface RuntimeState {
  lastFlushAt?: string;
  lastFlushOk?: boolean;
  lastFlushError?: string;
  startedAt?: string;
}

function ensureDir(): void {
  fs.mkdirSync(DEFAULT_DIR, { recursive: true });
}

export function writeSession(cfg: SessionConfig): void {
  ensureDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

export function readSession(): SessionConfig | null {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as SessionConfig;
    if (!raw.token || !raw.server) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeState(s: RuntimeState): void {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

export function readState(): RuntimeState {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as RuntimeState;
  } catch {
    return {};
  }
}

export function configDir(): string {
  return DEFAULT_DIR;
}
