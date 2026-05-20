import { BuildContext } from '../../evaluations/types/evaluation.types';
import { Phase } from '../../phase-tagger/types/phase.types';

export interface MentorArtifact {
  content: string;
}

export interface MentorInput {
  userId: string;
  question: string;
  planMd: string | null;
  signalResults: Record<
    string,
    { result: string; evidence: string; reasoning?: string }
  >;
  feedbackText: string;
  topActionableItems: string[];
  score: number;
  seniority: string | null;
  phase: Phase;
  buildContext?: BuildContext;
  crossPhase?: CrossPhaseSummary;
  model?: string;
  sessionId: string;
  evaluationId: string;
}

export interface CrossPhaseSummary {
  phase: Phase;
  score: number;
  feedbackText: string;
  topSignalsFired: Array<{
    id: string;
    polarity: 'good' | 'bad';
    result: string;
    evidence: string;
  }>;
}

export interface MentorResult {
  artifact: MentorArtifact;
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
