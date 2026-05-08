import { buildPlanEvalTool, SUBMIT_EVAL_TOOL_NAME } from './plan-tool-schema';
import { Rubric, RubricSignal } from '../types/rubric.types';

function signal(id: string, polarity: 'good' | 'bad' = 'good'): RubricSignal {
  return {
    id,
    polarity,
    weight: 'medium',
    description: 'd',
    judgeNotes: 'n',
  };
}

function rubric(signals: RubricSignal[]): Rubric {
  return {
    schemaVersion: 2,
    rubricVersion: 'v2.0',
    phase: 'plan',
    phaseName: 'Plan',
    goal: 'g',
    timeBounds: {
      targetMinMinutes: 30,
      targetMaxMinutes: 45,
      flagUnderMinutes: 15,
      flagOverMinutes: 60,
    },
    weightValues: { high: 3, medium: 2, low: 1 },
    passBar: {
      description: 'pb',
      requiredArtifact: 'plan.md',
      temporalCheck: 't',
      requiredSections: [],
    },
    signals,
    artifactsToInspect: [],
    judgeCalibration: [],
    scoring: {
      scaleMin: 1,
      scaleMax: 5,
      defaultScore: null,
      computation: 'c',
      anchors: {},
    },
    outputSchema: {},
  };
}

describe('buildPlanEvalTool', () => {
  it('uses the canonical tool name', () => {
    const tool = buildPlanEvalTool(rubric([signal('a')]));
    expect(tool.name).toBe(SUBMIT_EVAL_TOOL_NAME);
  });

  it('lists every rubric signal id under signals.required and properties', () => {
    const tool = buildPlanEvalTool(
      rubric([signal('a'), signal('b'), signal('c', 'bad')]),
    );
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = (schema.properties as Record<string, unknown>).signals as Record<
      string,
      unknown
    >;

    expect(props.required).toEqual(['a', 'b', 'c']);
    expect(Object.keys(props.properties as object)).toEqual(['a', 'b', 'c']);
  });

  it('forbids unknown signal ids via additionalProperties:false', () => {
    const tool = buildPlanEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const signalsSchema = (schema.properties as Record<string, unknown>).signals as Record<
      string,
      unknown
    >;
    expect(signalsSchema.additionalProperties).toBe(false);
    expect(schema.additionalProperties).toBe(false);
  });

  it('every signal entry is a $ref to #/$defs/signal (no inlined copies)', () => {
    const tool = buildPlanEvalTool(
      rubric([signal('a'), signal('b'), signal('c', 'bad')]),
    );
    const schema = tool.inputSchema as Record<string, unknown>;
    const signalsSchema = (schema.properties as Record<string, unknown>).signals as Record<
      string,
      unknown
    >;
    const props = signalsSchema.properties as Record<string, unknown>;

    for (const id of ['a', 'b', 'c']) {
      expect(props[id]).toEqual({ $ref: '#/$defs/signal' });
    }
  });

  it('the shared signal schema lives at $defs.signal with reasoning → result → evidence order', () => {
    const tool = buildPlanEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const defs = schema.$defs as Record<string, unknown>;
    const sub = defs.signal as Record<string, unknown>;

    expect(sub.required).toEqual(['reasoning', 'result', 'evidence']);
    expect(Object.keys(sub.properties as object)).toEqual(['reasoning', 'result', 'evidence']);
  });

  it('result is an enum of the four valid values (in $defs.signal)', () => {
    const tool = buildPlanEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const defs = schema.$defs as Record<string, unknown>;
    const sub = defs.signal as Record<string, unknown>;
    const result = (sub.properties as Record<string, unknown>).result as Record<string, unknown>;

    expect(result.enum).toEqual(['hit', 'partial', 'miss', 'cannot_evaluate']);
  });

  it('top-level requires signals, feedback, top_actions, gap_topics', () => {
    const tool = buildPlanEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(['signals', 'feedback', 'top_actions', 'gap_topics']);
  });

  it('gap_topics is bounded and points at the gap_topic def', () => {
    const tool = buildPlanEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    const gap = props.gap_topics as Record<string, unknown>;
    expect(gap.type).toBe('array');
    expect(gap.maxItems).toBe(5);
    expect(gap.items).toEqual({ $ref: '#/$defs/gap_topic' });
    const defs = schema.$defs as Record<string, unknown>;
    expect(defs.gap_topic).toBeDefined();
  });

  it('schema size scales with signal count (refs, not inlined copies)', () => {
    // 25 signals with $ref should be much smaller than the same with inlined sub-schemas.
    // The sub-schema serializes to ~400 chars, so 25 inlined copies add ~10KB.
    // Each $ref is ~28 chars; 25 refs add ~700 chars. Plus the canonical
    // topics enum lives in $defs.gap_topic — that's a fixed ~1.5KB cost
    // independent of signal count.
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const tool = buildPlanEvalTool(rubric(ids.map((id) => signal(id))));
    const serialized = JSON.stringify(tool.inputSchema);
    expect(serialized.length).toBeLessThan(4000);
  });
});
