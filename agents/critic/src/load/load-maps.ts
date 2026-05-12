import * as fs from 'node:fs';
import * as path from 'node:path';
import { MapperPackageMap } from '../types';

const PACKAGES = ['backend', 'frontend', 'cli'] as const;
export type CodebasePackage = (typeof PACKAGES)[number];

export interface LoadedMaps {
  byPackage: Record<CodebasePackage, MapperPackageMap>;
}

// Read the three per-package JSON sidecars the mapper produced. Each
// blocks the critic if missing — there's no fallback to re-running
// the mapper; the user runs them in sequence.
export function loadMaps(repoRoot: string): LoadedMaps {
  const byPackage = {} as Record<CodebasePackage, MapperPackageMap>;
  for (const pkg of PACKAGES) {
    const p = path.join(repoRoot, 'agents', 'codebase-map', `${pkg}.json`);
    if (!fs.existsSync(p)) {
      throw new Error(
        `Mapper output missing: ${p}. Run \`codebase-mapper --json\` first.`,
      );
    }
    const raw = fs.readFileSync(p, 'utf8');
    byPackage[pkg] = JSON.parse(raw) as MapperPackageMap;
  }
  return { byPackage };
}

export const CODEBASE_PACKAGES = PACKAGES;
