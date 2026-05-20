import { BuildContext, SignalResult } from '../../evaluations/types/evaluation.types';
import { RubricSignal } from '../../evaluations/types/rubric.types';
import { Phase } from '../../phase-tagger/types/phase.types';

export interface SignalMentorArtifact {
  annotations: Record<string, string>;
}

export interface GapSignalContext {
  signal: RubricSignal;
  result: SignalResult;
}

export interface SignalMentorInput {
  userId: string;
  question: string;
  planMd: string | null;
  gaps: GapSignalContext[];
  feedbackText: string;
  score: number;
  seniority: string | null;
  phase: Phase;
  buildContext?: BuildContext;
  model?: string;
  sessionId: string;
  evaluationId: string;
}

export interface SignalMentorResult {
  artifact: SignalMentorArtifact;
  renderedPrompt: string;
  audit: {
    modelUsed: string;
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    latencyMs: number;
  };
}
