import { Question, Seniority } from './question';

export type SessionStatus = 'active' | 'completed' | 'abandoned';

export interface Session {
  id: string;
  questionId: string;
  projectPath: string | null;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  seniority?: Seniority | null;
  overallScore: number | null;
  overallFeedback: string | null;
  buildStartedAt: string | null;
  buildEndedAt: string | null;
  buildEventCount: number;
}

export interface SessionWithQuestion extends Session {
  question: Question;
}

export interface SessionSummary {
  id: string;
  questionId: string;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  overallScore: number | null;
}
