import { Phase } from '../../phase-tagger/types/phase.types';
import { Mode, Seniority } from './rubric.types';

export interface PhaseEvalInput {
  session: {
    id: string;
    prompt: string;
    startedAt: Date;
    endedAt: Date | null;
  };
  planMd: string | null;
  snapshots: Array<{
    takenAt: Date;
    elapsedMinutes: number;
    planMdSize: number;
  }>;
  hints: Array<{
    occurredAt: Date;
    elapsedMinutes: number;
    prompt: string;
    response: string;
  }>;
  rubricVersion: string;
  mode?: Mode | null;
  seniority?: Seniority | null;
  model?: string;
  buildContext?: BuildContext;
}

export interface BuildContext {
  startedAt: Date | null;
  endedAt: Date | null;
  events: Array<{
    filePath: string;
    action: 'created' | 'modified' | 'deleted';
    contentDiff: string | null;
    occurredAt: Date;
  }>;
  finalTree: Array<{
    path: string;
    size: number;
    sha1: string;
  }>;
  keyFileSnippets: Array<{
    path: string;
    content: string;
  }>;
  aiTurns: Array<{
    externalSessionId: string;
    turnIndex: number;
    role: 'user' | 'assistant' | 'tool';
    text: string | null;
    toolName: string | null;
    toolInputSummary: string | null;
    toolResultSummary: string | null;
    occurredAt: Date;
  }>;
}

export interface SignalResult {
  result: 'hit' | 'miss' | 'partial' | 'cannot_evaluate';
  evidence: string;
  reasoning?: string;
}

export interface PhaseEvaluationResult {
  phase: Phase;
  score: number;
  signalResults: Record<string, SignalResult>;
  feedbackText: string;
  topActionableItems: string[];
  audit: EvaluationAuditPayload;
}

export interface EvaluationAuditPayload {
  prompt: string;
  rawResponse: string;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs?: number;
}

export interface SynthesisResult {
  overallScore: number;
  overallFeedback: string;
  recurringWeaknesses: string[];
}
