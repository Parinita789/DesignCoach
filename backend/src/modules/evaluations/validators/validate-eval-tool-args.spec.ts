import { validateEvalToolArgs } from './validate-eval-tool-args';
import { EvaluationParseError } from './parse-eval-output';

const SIGNALS = new Set(['scope_specificity', 'shape_and_seams']);

function ok(extra: Partial<Record<string, unknown>> = {}): unknown {
  return {
    signals: {
      scope_specificity: { reasoning: 'r1', result: 'hit', evidence: 'q1' },
      shape_and_seams: { reasoning: 'r2', result: 'partial', evidence: 'q2' },
    },
    feedback: 'fb',
    top_actions: ['a1', 'a2'],
    ...extra,
  };
}

describe('validateEvalToolArgs', () => {
  it('returns ParsedEvalOutput with reasoning preserved on each signal', () => {
    const out = validateEvalToolArgs(ok(), SIGNALS);
    expect(out.signals.scope_specificity.reasoning).toBe('r1');
    expect(out.signals.shape_and_seams.result).toBe('partial');
    expect(out.feedback).toBe('fb');
    expect(out.topActions).toEqual(['a1', 'a2']);
    expect(out.score).toBe(0);  });

  it('accepts topActions camelCase as fallback', () => {
    const args = ok();
    delete (args as Record<string, unknown>).top_actions;
    (args as Record<string, unknown>).topActions = ['x'];
    const out = validateEvalToolArgs(args, SIGNALS);
    expect(out.topActions).toEqual(['x']);
  });

  it('rejects unknown signal ids', () => {
    const args = ok() as Record<string, unknown>;
    (args.signals as Record<string, unknown>).bogus_id = {
      reasoning: 'r',
      result: 'hit',
      evidence: 'q',
    };
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/Unknown signal id "bogus_id"/);
  });

  it('rejects missing required signals', () => {
    const args = ok() as Record<string, unknown>;
    delete (args.signals as Record<string, unknown>).shape_and_seams;
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/Missing signal "shape_and_seams"/);
  });

  it('rejects bad result enum value', () => {
    const args = ok() as Record<string, unknown>;
    (args.signals as Record<string, unknown>).scope_specificity = {
      reasoning: 'r',
      result: 'maybe',
      evidence: 'q',
    };
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/result must be one of/);
  });

  it('rejects non-string evidence', () => {
    const args = ok() as Record<string, unknown>;
    (args.signals as Record<string, unknown>).scope_specificity = {
      reasoning: 'r',
      result: 'hit',
      evidence: 42,
    };
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/evidence must be a string/);
  });

  it('rejects when top-level signals object is missing', () => {
    const args = ok() as Record<string, unknown>;
    delete args.signals;
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/missing or invalid "signals"/i);
  });

  it('rejects when feedback is missing', () => {
    const args = ok() as Record<string, unknown>;
    delete args.feedback;
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/missing or non-string "feedback"/i);
  });

  it('rejects non-array top_actions', () => {
    const args = ok() as Record<string, unknown>;
    args.top_actions = 'not an array';
    expect(() => validateEvalToolArgs(args, SIGNALS)).toThrow(/non-array "top_actions"/i);
  });

  it('rejects null input', () => {
    expect(() => validateEvalToolArgs(null, SIGNALS)).toThrow(EvaluationParseError);
  });

  it('rejects an array as input', () => {
    expect(() => validateEvalToolArgs([], SIGNALS)).toThrow(/not a JSON object/);
  });

  it('omits reasoning if absent (optional)', () => {
    const args = {
      signals: {
        scope_specificity: { result: 'hit', evidence: 'q' },
        shape_and_seams: { result: 'miss', evidence: 'q' },
      },
      feedback: 'fb',
      top_actions: [],
    };
    const out = validateEvalToolArgs(args, SIGNALS);
    expect(out.signals.scope_specificity.reasoning).toBeUndefined();
  });
});
