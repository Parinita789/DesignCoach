import { computeFingerprint } from './compute-fingerprint';
import { BuildContext } from '../types/evaluation.types';

function makeBuildContext(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    startedAt: new Date('2026-05-07T09:00:00Z'),
    endedAt: new Date('2026-05-07T10:00:00Z'),
    events: [
      {
        filePath: 'a.ts',
        action: 'created',
        contentDiff: null,
        occurredAt: new Date('2026-05-07T09:30:00Z'),
      },
    ],
    finalTree: [{ path: 'a.ts', size: 100, sha1: 'abc' }],
    keyFileSnippets: [{ path: 'a.ts', content: 'export const a = 1;' }],
    allFileContents: [{ path: 'a.ts', content: 'export const a = 1;' }],
    aiTurns: [
      {
        externalSessionId: 'cc-1',
        turnIndex: 0,
        role: 'user',
        text: 'help me with auth',
        toolName: null,
        toolInputSummary: null,
        toolResultSummary: null,
        occurredAt: new Date('2026-05-07T09:20:00Z'),
      },
    ],
    ...overrides,
  };
}

describe('computeFingerprint — plan phase', () => {
  it('produces a 64-char hex SHA-256', () => {
    const fp = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-opus-4-7' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same fingerprint for identical inputs', () => {
    const a = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-opus-4-7' });
    const b = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-opus-4-7' });
    expect(a).toBe(b);
  });

  it('changes when planMd changes', () => {
    const a = computeFingerprint('plan', { planMd: '# Plan A', model: 'claude-opus-4-7' });
    const b = computeFingerprint('plan', { planMd: '# Plan B', model: 'claude-opus-4-7' });
    expect(a).not.toBe(b);
  });

  it('changes when model changes', () => {
    const a = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-opus-4-7' });
    const b = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-sonnet-4-6' });
    expect(a).not.toBe(b);
  });

  it('treats null planMd as empty-string (deterministic null handling)', () => {
    const a = computeFingerprint('plan', { planMd: null, model: 'claude-opus-4-7' });
    const b = computeFingerprint('plan', { planMd: '', model: 'claude-opus-4-7' });
    expect(a).toBe(b);
  });

  it('ignores buildContext for plan phase even if provided', () => {
    const a = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-opus-4-7' });
    const b = computeFingerprint('plan', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: makeBuildContext(),
    });
    expect(a).toBe(b);
  });
});

describe('computeFingerprint — build phase', () => {
  it('returns the same fingerprint for identical plan + build context', () => {
    const ctx = makeBuildContext();
    const a = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: ctx,
    });
    const b = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: makeBuildContext(),
    });
    expect(a).toBe(b);
  });

  it('changes when an event is added', () => {
    const a = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: makeBuildContext(),
    });
    const b = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: makeBuildContext({
        events: [
          ...makeBuildContext().events,
          {
            filePath: 'b.ts',
            action: 'modified',
            contentDiff: '--- a\n+++ b\n@@ ...',
            occurredAt: new Date('2026-05-07T09:40:00Z'),
          },
        ],
      }),
    });
    expect(a).not.toBe(b);
  });

  it('changes when an event\'s contentDiff changes', () => {
    const base = makeBuildContext();
    const a = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: { ...base, events: [{ ...base.events[0], contentDiff: 'diff-a' }] },
    });
    const b = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: { ...base, events: [{ ...base.events[0], contentDiff: 'diff-b' }] },
    });
    expect(a).not.toBe(b);
  });

  it('does NOT change when derived fields (finalTree, keyFileSnippets) change but events are identical', () => {
    // Sanity check: we only hash structural facts (events + aiTurns).
    // Derived views shouldn't contribute to the fingerprint.
    const base = makeBuildContext();
    const a = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: { ...base, finalTree: [{ path: 'x', size: 1, sha1: 'aaa' }] },
    });
    const b = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: { ...base, finalTree: [{ path: 'y', size: 999, sha1: 'zzz' }] },
    });
    expect(a).toBe(b);
  });

  it('plan and build phases with the same planMd produce different fingerprints', () => {
    const a = computeFingerprint('plan', { planMd: '# Plan', model: 'claude-opus-4-7' });
    const b = computeFingerprint('build', {
      planMd: '# Plan',
      model: 'claude-opus-4-7',
      buildContext: makeBuildContext(),
    });
    // Same planMd + model, but build adds the buildContext key, so the
    // canonical JSON differs. (And per-phase lookup column is also
    // separate in the DB.)
    expect(a).not.toBe(b);
  });
});
