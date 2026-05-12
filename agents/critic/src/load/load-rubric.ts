import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Load rubric.md verbatim. Also return a sha1 so issues.json can
// record which rubric version produced each run.
export function loadRubric(
  repoRoot: string,
  override?: string,
): { text: string; resolvedPath: string; sha1: string } {
  const candidate = override
    ? path.isAbsolute(override)
      ? override
      : path.join(repoRoot, override)
    : path.join(repoRoot, 'agents', 'critic', 'rubric.md');
  if (!fs.existsSync(candidate)) {
    throw new Error(`Rubric not found at ${candidate}.`);
  }
  const text = fs.readFileSync(candidate, 'utf8');
  const sha1 = crypto.createHash('sha1').update(text).digest('hex');
  return { text, resolvedPath: candidate, sha1 };
}
