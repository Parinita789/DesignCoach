import { SignalMentorAgent } from './signal-mentor.agent';
import {
  buildAnnotationsTool,
  SUBMIT_ANNOTATIONS_TOOL_NAME,
} from '../prompts/signal-mentor-prompt';
import { SignalMentorInput } from '../types/signal-mentor.types';
import { RubricSignal } from '../../evaluations/types/rubric.types';
import { LlmResponse } from '../../llm/types/llm.types';

function gap(id: string, polarity: 'good' | 'bad', verdict: 'hit' | 'miss' | 'partial') {
  const signal: RubricSignal = {
    id,
    polarity,
    weight: 'medium',
    description: `desc ${id}`,
    judgeNotes: `notes ${id}`,
  };
  return {
    signal,
    result: { result: verdict, evidence: `quoted ${id}` } as const,
  };
}

function makeInput(...gaps: ReturnType<typeof gap>[]): SignalMentorInput {
  return {
    userId: 'uid-1',
    question: 'design a URL shortener',
    planMd: '# Plan\n\nshort plan body',
    gaps: gaps as SignalMentorInput['gaps'],
    feedbackText: 'overall: ok',
    score: 3.2,
    seniority: 'mid',
    phase: 'plan',
    sessionId: 'sid-1',
    evaluationId: 'eid-1',
  };
}

function makeLlm(opts: {
  supportsToolUse: boolean;
  response: Partial<LlmResponse>;
}) {
  const call = jest.fn().mockResolvedValue({
    text: '',
    toolUse: undefined,
    modelUsed: 'claude-opus-4-7',
    tokensIn: 10,
    tokensOut: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...opts.response,
  } satisfies LlmResponse);
  return {
    llm: {
      supportsToolUse: () => opts.supportsToolUse,
      call,
    } as never,
    call,
  };
}

describe('SignalMentorAgent', () => {
  describe('buildAnnotationsTool', () => {
    it('builds a schema with required = gap ids and additionalProperties: false', () => {
      const tool = buildAnnotationsTool(['scope_realism', 'no_validation_plan']);
      expect(tool.name).toBe(SUBMIT_ANNOTATIONS_TOOL_NAME);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toEqual([
        'scope_realism',
        'no_validation_plan',
      ]);
      const props = (tool.inputSchema.properties as Record<string, unknown>);
      expect(Object.keys(props)).toEqual(['scope_realism', 'no_validation_plan']);
    });
  });

  describe('tool-use path', () => {
    it('round-trips annotations from tool_use input', async () => {
      const input = makeInput(
        gap('scope_realism', 'good', 'miss'),
        gap('no_validation_plan', 'bad', 'hit'),
      );
      const { llm, call } = makeLlm({
        supportsToolUse: true,
        response: {
          toolUse: {
            name: SUBMIT_ANNOTATIONS_TOOL_NAME,
            input: {
              scope_realism: 'You should narrow scope to redirect-only.',
              no_validation_plan: 'Sketch a curl loop at demo scale.',
            },
          },
        },
      });

      const agent = new SignalMentorAgent(llm);
      const out = await agent.generate(input);

      expect(out.artifact.annotations).toEqual({
        scope_realism: 'You should narrow scope to redirect-only.',
        no_validation_plan: 'Sketch a curl loop at demo scale.',
      });
      const opts = call.mock.calls[0][1];
      expect(opts.tools[0].name).toBe(SUBMIT_ANNOTATIONS_TOOL_NAME);
      expect(opts.toolChoice).toEqual({
        type: 'tool',
        name: SUBMIT_ANNOTATIONS_TOOL_NAME,
      });
    });

    it('drops hallucinated ids the LLM emits outside the gap set', async () => {
      const input = makeInput(gap('scope_realism', 'good', 'miss'));
      const { llm } = makeLlm({
        supportsToolUse: true,
        response: {
          toolUse: {
            name: SUBMIT_ANNOTATIONS_TOOL_NAME,
            input: {
              scope_realism: 'narrow scope',
              hallucinated_id: 'should be dropped',
            },
          },
        },
      });

      const agent = new SignalMentorAgent(llm);
      const out = await agent.generate(input);
      expect(out.artifact.annotations).toEqual({ scope_realism: 'narrow scope' });
    });
  });

  describe('text-mode fallback', () => {
    it('parses a top-level JSON object map of {id: string}', async () => {
      const input = makeInput(
        gap('scope_realism', 'good', 'miss'),
        gap('no_validation_plan', 'bad', 'hit'),
      );
      const { llm } = makeLlm({
        supportsToolUse: false,
        response: {
          text: JSON.stringify({
            scope_realism: 'narrow scope',
            no_validation_plan: 'sketch a smoke test',
          }),
        },
      });

      const agent = new SignalMentorAgent(llm);
      const out = await agent.generate(input);
      expect(out.artifact.annotations).toEqual({
        scope_realism: 'narrow scope',
        no_validation_plan: 'sketch a smoke test',
      });
    });

    it('strips ```json fences and extracts JSON from prose', async () => {
      const input = makeInput(gap('scope_realism', 'good', 'miss'));
      const { llm } = makeLlm({
        supportsToolUse: false,
        response: {
          text:
            'Sure, here are the annotations:\n```json\n{"scope_realism":"narrow scope"}\n```',
        },
      });
      const agent = new SignalMentorAgent(llm);
      const out = await agent.generate(input);
      expect(out.artifact.annotations).toEqual({ scope_realism: 'narrow scope' });
    });

    it('accepts a wrapping {annotations: {...}} envelope', async () => {
      const input = makeInput(gap('scope_realism', 'good', 'miss'));
      const { llm } = makeLlm({
        supportsToolUse: false,
        response: {
          text: JSON.stringify({ annotations: { scope_realism: 'narrow scope' } }),
        },
      });
      const agent = new SignalMentorAgent(llm);
      const out = await agent.generate(input);
      expect(out.artifact.annotations).toEqual({ scope_realism: 'narrow scope' });
    });

    it('drops unknown ids and survives malformed JSON gracefully', async () => {
      const input = makeInput(gap('scope_realism', 'good', 'miss'));
      const { llm } = makeLlm({
        supportsToolUse: false,
        response: { text: 'I cannot evaluate this.' },
      });
      const agent = new SignalMentorAgent(llm);
      const out = await agent.generate(input);
      expect(out.artifact.annotations).toEqual({});
    });
  });

  it('returns audit fields from the LlmResponse', async () => {
    const input = makeInput(gap('scope_realism', 'good', 'miss'));
    const { llm } = makeLlm({
      supportsToolUse: true,
      response: {
        toolUse: {
          name: SUBMIT_ANNOTATIONS_TOOL_NAME,
          input: { scope_realism: 'x' },
        },
        modelUsed: 'claude-opus-4-7',
        tokensIn: 111,
        tokensOut: 222,
        cacheCreationTokens: 33,
        cacheReadTokens: 44,
      },
    });
    const agent = new SignalMentorAgent(llm);
    const out = await agent.generate(input);
    expect(out.audit).toMatchObject({
      modelUsed: 'claude-opus-4-7',
      tokensIn: 111,
      tokensOut: 222,
      cacheCreationTokens: 33,
      cacheReadTokens: 44,
    });
    expect(out.audit.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
