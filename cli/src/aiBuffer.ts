import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NormalizedAITurn } from './aiLogs';

export type BufferedAITurn = NormalizedAITurn & { id: number; sent: boolean };

const DEFAULT_DIR = path.join(os.homedir(), '.mentor');

// Sibling to EventBuffer (file-event buffer). Same JSONL + cursor
// pattern; different payload shape and a different cursor sidecar so
// the two buffers can't accidentally cross-mark each other's ids.
export class AIBuffer {
  private file: string;
  private cursorFile: string;
  private nextId = 1;
  private events: BufferedAITurn[] = [];

  constructor(opts: { dir?: string; file?: string } = {}) {
    const dir = opts.dir ?? DEFAULT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    this.file = opts.file ?? path.join(dir, 'ai-buffer.jsonl');
    this.cursorFile = path.join(path.dirname(this.file), 'ai-sent-cursor.json');
    this.load();
  }

  private load(): void {
    let sentIds = new Set<number>();
    if (fs.existsSync(this.cursorFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cursorFile, 'utf-8'));
        if (Array.isArray(raw?.sentIds)) sentIds = new Set(raw.sentIds);
      } catch {
        sentIds = new Set();
      }
    }
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as BufferedAITurn;
        row.sent = sentIds.has(row.id);
        this.events.push(row);
        if (row.id >= this.nextId) this.nextId = row.id + 1;
      } catch {
        // truncated tail; ignore
      }
    }
  }

  append(turn: NormalizedAITurn): BufferedAITurn {
    const row: BufferedAITurn = { ...turn, id: this.nextId++, sent: false };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf-8');
    this.events.push(row);
    return row;
  }

  unsent(limit = 100): BufferedAITurn[] {
    const out: BufferedAITurn[] = [];
    for (const e of this.events) {
      if (!e.sent) out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  markSent(ids: number[]): void {
    const idSet = new Set(ids);
    for (const e of this.events) {
      if (idSet.has(e.id)) e.sent = true;
    }
    fs.writeFileSync(
      this.cursorFile,
      JSON.stringify({ sentIds: this.events.filter((e) => e.sent).map((e) => e.id) }),
      'utf-8',
    );
  }

  size(): { total: number; unsent: number } {
    const total = this.events.length;
    const unsent = this.events.filter((e) => !e.sent).length;
    return { total, unsent };
  }

  filePath(): string {
    return this.file;
  }
}
