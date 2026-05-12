import * as fs from 'node:fs';
import * as path from 'node:path';

// Read backend-api-flow.json and reduce it to a per-endpoint
// summary the synthesis prompt can consume. The raw file is ~137KB
// because it's recursive call trees down to Prisma leaves; we keep
// just route + module + the top 2 call-tree levels.

interface RawCallTreeNode {
  id: string;
  type: string;
  label: string;
  file?: string;
  children?: RawCallTreeNode[];
}

interface RawEndpoint {
  id: string;
  module: string;
  controller: string;
  method: string;
  httpVerb: string;
  route: string;
  callTree: RawCallTreeNode;
  cliCallers: Array<{ triggeringCommands: string[] }>;
}

interface RawApiFlow {
  package: string;
  generatedAt: string;
  endpoints: RawEndpoint[];
}

export interface CondensedEndpoint {
  route: string;
  module: string;
  controller: string;
  method: string;
  callPathTop2: string[]; // [root.label, ...child[0..N].label] up to 2 levels deep
  cliCommands: string[];
}

export function loadCondensedApiFlow(repoRoot: string): CondensedEndpoint[] | null {
  const p = path.join(repoRoot, 'agents', 'codebase-map', 'backend-api-flow.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as RawApiFlow;
  return raw.endpoints.map((e) => ({
    route: e.route,
    module: e.module,
    controller: e.controller,
    method: e.method,
    callPathTop2: top2(e.callTree),
    cliCommands: dedupe(
      e.cliCallers.flatMap((c) => c.triggeringCommands ?? []),
    ),
  }));
}

function top2(node: RawCallTreeNode): string[] {
  const path: string[] = [node.label];
  for (const child of node.children ?? []) {
    path.push(child.label);
  }
  return path;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
