import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolve persona by name. Search order:
//   1. agents/critic/personas/<name>.md (the shipped personas)
//   2. <name> interpreted as a path (absolute or relative to repoRoot)
export function loadPersona(repoRoot: string, name: string): { text: string; resolvedPath: string } {
  const shipped = path.join(repoRoot, 'agents', 'critic', 'personas', `${name}.md`);
  if (fs.existsSync(shipped)) {
    return { text: fs.readFileSync(shipped, 'utf8'), resolvedPath: shipped };
  }
  const direct = path.isAbsolute(name) ? name : path.join(repoRoot, name);
  if (fs.existsSync(direct)) {
    return { text: fs.readFileSync(direct, 'utf8'), resolvedPath: direct };
  }
  throw new Error(
    `Persona '${name}' not found. Looked at ${shipped} and ${direct}. ` +
      `Drop a markdown file at agents/critic/personas/${name}.md or pass an explicit path.`,
  );
}
