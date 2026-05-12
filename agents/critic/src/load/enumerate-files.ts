import * as fs from 'node:fs';
import * as path from 'node:path';
import { MapperModuleSummary } from '../types';

// For a module summary (whose `path` is either a directory or a
// single file relative to repoRoot), enumerate the .ts/.tsx source
// files we want to review. Excludes test files and the usual noise
// dirs.
//
// The result is the absolute paths in sorted order so reviews are
// reproducible.

const SOURCE_EXT = /\.(?:tsx?|mts|cts)$/;
const TEST_EXT = /\.(?:test|spec)\.(?:tsx?)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.git',
]);

export interface EnumerateOptions {
  includeTests?: boolean;
  maxFiles?: number;
}

export function enumerateModuleFiles(
  repoRoot: string,
  module: MapperModuleSummary,
  opts: EnumerateOptions = {},
): string[] {
  const abs = path.join(repoRoot, module.path);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  const collected: string[] = [];

  if (stat.isFile()) {
    if (matchesFile(abs, opts.includeTests)) collected.push(abs);
  } else if (stat.isDirectory()) {
    walk(abs, opts.includeTests, collected);
  }

  collected.sort();
  return opts.maxFiles ? collected.slice(0, opts.maxFiles) : collected;
}

function walk(dir: string, includeTests: boolean | undefined, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), includeTests, out);
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      if (matchesFile(full, includeTests)) out.push(full);
    }
  }
}

function matchesFile(p: string, includeTests: boolean | undefined): boolean {
  if (!SOURCE_EXT.test(p)) return false;
  if (!includeTests && TEST_EXT.test(p)) return false;
  return true;
}
