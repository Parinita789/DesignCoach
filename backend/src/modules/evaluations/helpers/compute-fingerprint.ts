import { createHash } from 'node:crypto';
import { Phase } from '../../phase-tagger/types/phase.types';
import { BuildContext } from '../types/evaluation.types';

export interface FingerprintInputs {
  planMd: string | null;
  model: string;
  buildContext?: BuildContext;
}

// SHA-256 hex of the inputs that materially determine eval output.
//
// Scope (per design decision: re-evaluate ONLY when the candidate's
// output changes — not when hints, rubric, question, or seniority
// change, since those don't shift per-session for the same eval):
//
//   plan phase  : planMd + model
//   build phase : planMd + model + structural facts of build artifacts
//                 (events + aiTurns; we exclude derived fields like
//                 finalTree since they're computed from events)
//
// Returns 64-char hex string. Stable across processes (canonical-JSON
// serialization, sorted keys).
export function computeFingerprint(phase: Phase, inputs: FingerprintInputs): string {
  const canonical: Record<string, unknown> = {
    model: inputs.model,
    planMd: inputs.planMd ?? '',
  };

  if (phase === 'build' && inputs.buildContext) {
    canonical.buildContext = summarizeBuildContext(inputs.buildContext);
  }

  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

// Reduce a BuildContext to just the bits that determine eval output.
// `finalTree`, `keyFileSnippets`, `allFileContents` are derived from
// `events` so including them would double-count. AI turn metadata
// (externalSessionId + turnIndex) is enough — full text isn't part of
// the eval prompt for build phase.
function summarizeBuildContext(ctx: BuildContext): Record<string, unknown> {
  return {
    events: ctx.events.map((e) => ({
      filePath: e.filePath,
      action: e.action,
      occurredAt: e.occurredAt instanceof Date ? e.occurredAt.toISOString() : String(e.occurredAt),
      contentDiff: e.contentDiff ?? '',
    })),
    aiTurns: ctx.aiTurns.map((t) => ({
      externalSessionId: t.externalSessionId,
      turnIndex: t.turnIndex,
    })),
  };
}

// JSON.stringify with sorted object keys at every depth so the byte
// output is stable regardless of how the object was built.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}
