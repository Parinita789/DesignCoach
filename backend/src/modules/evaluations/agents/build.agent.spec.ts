import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import { BuildAgent } from './build.agent';
import { LlmService } from '../../llm/services/llm.service';
import { RubricLoaderService } from '../services/rubric-loader.service';
import { PhaseEvalInput } from '../types/evaluation.types';
import { LlmResponse } from '../../llm/types/llm.types';
import { SUBMIT_BUILD_EVAL_TOOL_NAME } from '../prompts/build-tool-schema';

function makeLlm(opts: {
  toolUse?: LlmResponse['toolUse'];
  text?: string;
  supportsToolUse?: boolean;
}): { svc: LlmService; calls: jest.Mock } {
  const calls = jest.fn().mockResolvedValue({
    text: opts.text ?? '',
    toolUse: opts.toolUse,
    modelUsed: 'fake-model',
    tokensIn: 10,
    tokensOut: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  } satisfies LlmResponse);
  const svc = {
    call: calls,
    supportsToolUse: () => opts.supportsToolUse ?? true,
  } as unknown as LlmService;
  return { svc, calls };
}

function makeInput(overrides: Partial<PhaseEvalInput> = {}): PhaseEvalInput {
  return {
    session: {
      id: 'sid',
      prompt: 'Design a URL shortener.',
      startedAt: new Date('2026-05-07T09:00:00Z'),
      endedAt: new Date('2026-05-07T10:00:00Z'),
    },
    planMd:
      '# Plan\nScope: implement /shorten and /:slug.\nComponent boundaries: handlers/ -> services/ -> repos/.\nValidation: pytest covers each endpoint.',
    snapshots: [],
    hints: [],
    rubricVersion: 'v2.0',
    mode: 'build',
    seniority: 'mid',
    buildContext: {
      startedAt: new Date('2026-05-07T09:20:00Z'),
      endedAt: new Date('2026-05-07T09:55:00Z'),
      events: [
        {
          filePath: 'handlers.ts',
          action: 'created',
          contentDiff: null,
          occurredAt: new Date('2026-05-07T09:25:00Z'),
        },
      ],
      finalTree: [{ path: 'handlers.ts', size: 100, sha1: 'abc' }],
      keyFileSnippets: [{ path: 'handlers.ts', content: 'export const post = ...' }],
      aiTurns: [],
    },
    ...overrides,
  };
}

function loader(): RubricLoaderService {
  const cfg = new ConfigService({
    rubric: { dir: path.resolve(__dirname, '../../../../rubrics') },
  });
  return new RubricLoaderService(cfg);
}

describe('BuildAgent', () => {
  it('loads the build rubric, forces the build tool, and returns a result with phase=build', async () => {
    const { svc, calls } = makeLlm({
      toolUse: {
        name: SUBMIT_BUILD_EVAL_TOOL_NAME,
        input: {
          signals: {
            code_matches_plan: { reasoning: 'r', result: 'hit', evidence: 'handlers.ts present' },
            incremental_build: { reasoning: 'r', result: 'partial', evidence: 'one event captured' },
            structure_soundness: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'minimal tree' },
            test_appropriateness: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no test files captured' },
            design_evolution_coherence: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no drift visible' },
            ai_used_as_collaborator: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no ai turns' },
            silent_drift: { reasoning: 'r', result: 'miss', evidence: 'code aligns with plan' },
            dead_files: { reasoning: 'r', result: 'miss', evidence: 'all files referenced' },
            no_tests: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'plan did not require tests' },
            commit_dump: { reasoning: 'r', result: 'miss', evidence: 'one event window' },
            ai_dictation: { reasoning: 'r', result: 'miss', evidence: 'no ai turns' },
          },
          feedback: 'Build mode evaluation. Minimal session.',
          top_actions: ['Add tests next time'],
        },
      },
    });

    const agent = new BuildAgent(svc, loader());
    const result = await agent.evaluate(makeInput());

    expect(result.phase).toBe('build');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
    expect(result.feedbackText).toContain('Build mode');
    expect(Object.keys(result.signalResults).length).toBeGreaterThan(0);

    expect(calls).toHaveBeenCalledTimes(1);
    const callArgs = calls.mock.calls[0][1];
    expect(callArgs.toolChoice).toEqual({ type: 'tool', name: SUBMIT_BUILD_EVAL_TOOL_NAME });
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe(SUBMIT_BUILD_EVAL_TOOL_NAME);
  });

  it('warns when buildContext is missing (still produces a result by parsing whatever the LLM says)', async () => {
    const { svc } = makeLlm({
      toolUse: {
        name: SUBMIT_BUILD_EVAL_TOOL_NAME,
        input: {
          signals: {
            code_matches_plan: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            incremental_build: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            structure_soundness: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            test_appropriateness: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            design_evolution_coherence: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            ai_used_as_collaborator: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            silent_drift: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            dead_files: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            no_tests: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            commit_dump: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
            ai_dictation: { reasoning: 'r', result: 'cannot_evaluate', evidence: 'no context' },
          },
          feedback: 'No context.',
          top_actions: [],
        },
      },
    });

    const agent = new BuildAgent(svc, loader());
    const result = await agent.evaluate(makeInput({ buildContext: undefined }));
    expect(result.phase).toBe('build');
  });
});
