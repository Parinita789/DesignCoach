import { buildBuildEvalTool, SUBMIT_BUILD_EVAL_TOOL_NAME } from './build-tool-schema';
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
    phase: 'build',
    phaseName: 'Build',
    goal: 'g',
    timeBounds: {
      targetMinMinutes: 25,
      targetMaxMinutes: 45,
      flagUnderMinutes: 10,
      flagOverMinutes: 60,
    },
    weightValues: { high: 3, medium: 2, low: 1 },
    passBar: {
      description: 'pb',
      requiredArtifact: 'build_events',
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

describe('buildBuildEvalTool', () => {
  it('uses the build-specific tool name', () => {
    const tool = buildBuildEvalTool(rubric([signal('a')]));
    expect(tool.name).toBe(SUBMIT_BUILD_EVAL_TOOL_NAME);
    expect(tool.name).not.toBe('submit_evaluation');
  });

  it('lists every rubric signal id under signals.required and properties', () => {
    const tool = buildBuildEvalTool(
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
    const tool = buildBuildEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const signalsSchema = (schema.properties as Record<string, unknown>).signals as Record<
      string,
      unknown
    >;
    expect(signalsSchema.additionalProperties).toBe(false);
    expect(schema.additionalProperties).toBe(false);
  });

  it('every signal entry is a $ref to #/$defs/signal', () => {
    const tool = buildBuildEvalTool(
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

  it('result enum is the four valid verdicts', () => {
    const tool = buildBuildEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const defs = schema.$defs as Record<string, unknown>;
    const sub = defs.signal as Record<string, unknown>;
    const result = (sub.properties as Record<string, unknown>).result as Record<string, unknown>;
    expect(result.enum).toEqual(['hit', 'partial', 'miss', 'cannot_evaluate']);
  });

  it('top-level requires signals, feedback, top_actions, gap_topics', () => {
    const tool = buildBuildEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(['signals', 'feedback', 'top_actions', 'gap_topics']);
  });

  it('gap_topics is bounded and points at the gap_topic def', () => {
    const tool = buildBuildEvalTool(rubric([signal('a')]));
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    const gap = props.gap_topics as Record<string, unknown>;
    expect(gap.type).toBe('array');
    expect(gap.maxItems).toBe(5);
    expect(gap.items).toEqual({ $ref: '#/$defs/gap_topic' });
    const defs = schema.$defs as Record<string, unknown>;
    expect(defs.gap_topic).toBeDefined();
  });
});
