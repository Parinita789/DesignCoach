import { Rubric } from '../types/rubric.types';
import { ToolDefinition } from '../../llm/types/llm.types';

export const SUBMIT_BUILD_EVAL_TOOL_NAME = 'submit_build_evaluation';

const RESULT_ENUM = ['hit', 'partial', 'miss', 'cannot_evaluate'] as const;

const SIGNAL_SUB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'result', 'evidence'],
  properties: {
    reasoning: {
      type: 'string',
      maxLength: 400,
      description: 'Brief reasoning written before committing to result.',
    },
    result: {
      type: 'string',
      enum: RESULT_ENUM,
    },
    evidence: {
      type: 'string',
      maxLength: 500,
      description:
        'Verbatim quote from a captured artifact (plan.md, file content, event timeline, or AI turn). For cannot_evaluate, explain why the signal is not applicable.',
    },
  },
} as const;

const SIGNAL_REF = { $ref: '#/$defs/signal' } as const;

export function buildBuildEvalTool(rubric: Rubric): ToolDefinition {
  const signalIds = rubric.signals.map((s) => s.id);
  const signalProperties: Record<string, unknown> = {};
  for (const id of signalIds) {
    signalProperties[id] = SIGNAL_REF;
  }

  return {
    name: SUBMIT_BUILD_EVAL_TOOL_NAME,
    description:
      "Submit the structured evaluation of the candidate's build phase, scored against the build rubric.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['signals', 'feedback', 'top_actions'],
      $defs: {
        signal: SIGNAL_SUB_SCHEMA,
      },
      properties: {
        signals: {
          type: 'object',
          additionalProperties: false,
          required: signalIds,
          properties: signalProperties,
        },
        feedback: { type: 'string', maxLength: 3000 },
        top_actions: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string', maxLength: 200 },
        },
      },
    },
  };
}
