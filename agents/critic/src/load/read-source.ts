import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_LINE_CAP = 1500;

export interface SourceFile {
  absPath: string;
  repoPath: string;
  text: string;
  lineCount: number;
  truncated: boolean;
  truncatedAfter: number;
  // Source with 1-indexed line prefixes, ready to drop into a prompt.
  withLineNumbers: string;
}

export function readSourceFile(
  repoRoot: string,
  absPath: string,
  lineCap: number = DEFAULT_LINE_CAP,
): SourceFile {
  const raw = fs.readFileSync(absPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const lineCount = lines.length;
  const truncated = lineCount > lineCap;
  const truncatedAfter = truncated ? lineCap : lineCount;
  const kept = truncated ? lines.slice(0, lineCap) : lines;
  const width = String(truncatedAfter).length;
  const withLineNumbers = kept
    .map((l, i) => `${String(i + 1).padStart(width)} | ${l}`)
    .join('\n');

  return {
    absPath,
    repoPath: path.relative(repoRoot, absPath),
    text: raw,
    lineCount,
    truncated,
    truncatedAfter,
    withLineNumbers,
  };
}
