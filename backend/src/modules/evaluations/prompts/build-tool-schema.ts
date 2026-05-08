import { Rubric } from '../types/rubric.types';
import { ToolDefinition } from '../../llm/types/llm.types';
import { CANONICAL_TOPICS } from '../helpers/canonical-topics';

export const SUBMIT_BUILD_EVAL_TOOL_NAME = 'submit_build_evaluation';

const GAP_TOPIC_SUB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'coverage', 'why_expected'],
  properties: {
    name: {
      type: 'string',
      enum: [...CANONICAL_TOPICS],
      description: 'Topic id from the canonical system-design vocabulary.',
    },
    coverage: {
      type: 'string',
      enum: ['missed', 'lightly_touched'],
    },
    why_expected: {
      type: 'string',
      maxLength: 400,
      description:
        '1-2 sentences naming what about THIS question (stated NFRs, plan.md commitments, captured code, or AI conversation) makes this topic expected.',
    },
  },
} as const;

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
      required: ['signals', 'feedback', 'top_actions', 'gap_topics'],
      $defs: {
        signal: SIGNAL_SUB_SCHEMA,
        gap_topic: GAP_TOPIC_SUB_SCHEMA,
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
        gap_topics: {
          type: 'array',
          maxItems: 5,
          items: { $ref: '#/$defs/gap_topic' },
          description:
            'Up to 5 system-design topics directly relevant to THIS question that the candidate missed or only lightly touched, judged from the captured plan/code/AI artifacts. Empty array is valid.',
        },
      },
    },
  };
}
