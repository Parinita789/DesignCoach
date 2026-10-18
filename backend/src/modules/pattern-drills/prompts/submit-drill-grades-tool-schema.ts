import { ToolDefinition } from '../../llm/types/llm.types';

export const SUBMIT_DRILL_GRADES_TOOL_NAME = 'submit_drill_grades';

const ITEM_GRADE_SUB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['patternCorrect', 'triggerPhraseAcceptable', 'explanation'],
  properties: {
    patternCorrect: { type: 'boolean' },
    triggerPhraseAcceptable: { type: 'boolean' },
    explanation: { type: 'string' },
  },
} as const;

// Item IDs are dynamic per generated set, same as buildPlanResultsTool(rubric)
// keys its schema off the rubric's signal IDs.
export function buildSubmitDrillGradesTool(itemIds: string[]): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (const id of itemIds) {
    properties[id] = { $ref: '#/$defs/item_grade' };
  }

  return {
    name: SUBMIT_DRILL_GRADES_TOOL_NAME,
    description:
      'Grade each drill answer against its canonical pattern/trigger-phrase/first-move. Do not compute an overall verdict — the calling application derives that deterministically from patternCorrect and triggerPhraseAcceptable.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: itemIds,
      $defs: { item_grade: ITEM_GRADE_SUB_SCHEMA },
      properties,
    },
  };
}
