import { applyPatch } from 'diff';
import { createHash } from 'node:crypto';

export interface BuildEventForTree {
  filePath: string;
  action: string;
  content: string | null;
  contentDiff: string | null;
  occurredAt: Date;
}

export interface FinalTreeEntry {
  path: string;
  size: number;
  sha1: string;
}

export interface ReconstructedTree {
  tree: FinalTreeEntry[];
  contents: Map<string, string>;
  brokenPatchPaths: string[];
}

// Walks the events in chronological order, applying created / modified /
// deleted to a path -> content map. Returns the surviving entries.
//
// Diffs that fail to apply (context mismatch from a missed earlier event,
// or a CLI-side rebaseline boundary issue) leave the prior content in
// place and the path is added to brokenPatchPaths so callers can report
// the gap. Reconstruction does NOT abort — the rest of the tree is still
// useful.
export function reconstructBuildTree(events: BuildEventForTree[]): ReconstructedTree {
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const contents = new Map<string, string>();
  const brokenPatchPaths = new Set<string>();

  for (const e of ordered) {
    if (e.action === 'deleted') {
      contents.delete(e.filePath);
      continue;
    }
    if (e.content !== null) {
      contents.set(e.filePath, e.content);
      continue;
    }
    if (e.contentDiff && e.contentDiff.length > 0) {
      const prior = contents.get(e.filePath);
      if (prior === undefined) {
        brokenPatchPaths.add(e.filePath);
        continue;
      }
      const patched = applyPatch(prior, e.contentDiff);
      if (patched === false) {
        brokenPatchPaths.add(e.filePath);
        continue;
      }
      contents.set(e.filePath, patched);
    }
  }

  const tree: FinalTreeEntry[] = [];
  for (const [path, content] of contents) {
    const size = Buffer.byteLength(content, 'utf-8');
    const sha1 = createHash('sha1').update(content).digest('hex');
    tree.push({ path, size, sha1 });
  }
  tree.sort((a, b) => a.path.localeCompare(b.path));

  return { tree, contents, brokenPatchPaths: [...brokenPatchPaths] };
}
