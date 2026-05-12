import * as fs from 'node:fs';
import * as path from 'node:path';
import { CODEBASE_PACKAGES, CodebasePackage } from './load-maps';

// Extract just the ```mermaid``` block from each per-package
// MODULE_RELATIONSHIPS.md. Strips the surrounding prose so the
// synthesis prompt gets the raw graph (token-efficient) rather than
// the full document.
export type GraphsByPackage = Record<CodebasePackage, string | null>;

export function loadModuleGraphs(repoRoot: string): GraphsByPackage {
  const out = {} as GraphsByPackage;
  for (const pkg of CODEBASE_PACKAGES) {
    const p = path.join(
      repoRoot,
      'agents',
      'graphify',
      `${pkg}-module-level`,
      'MODULE_RELATIONSHIPS.md',
    );
    out[pkg] = fs.existsSync(p) ? extractMermaid(fs.readFileSync(p, 'utf8')) : null;
  }
  return out;
}

function extractMermaid(md: string): string | null {
  // First ```mermaid``` block; graphify only emits one per file.
  const match = md.match(/```mermaid\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}
