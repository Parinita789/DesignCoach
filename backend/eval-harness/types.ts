export type SignalMode = 'hit' | 'partial' | 'miss' | 'credited' | 'skipped';
export type RubricMode = 'build' | 'design';
export type FixtureSeniority = 'junior' | 'mid' | 'senior' | 'staff';
export type FixturePhase = 'plan' | 'build';

export interface FixtureExpectation {
  expectedScore: { min: number; max: number };
  expectedSignals: Partial<Record<SignalMode, string[]>>;
  warnOnly?: boolean;
}

export interface FixtureHint {
  occurredAt: string;
  elapsedMinutes: number;
  prompt: string;
  response: string;
}

export interface FixtureBuildEvent {
  filePath: string;
  action: 'created' | 'modified' | 'deleted';
  content: string | null;
  contentDiff: string | null;
  occurredAt: string;
}

export interface FixtureAITurn {
  externalSessionId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  text: string | null;
  toolName: string | null;
  toolInputSummary: string | null;
  toolResultSummary: string | null;
  occurredAt: string;
}

export interface Fixture extends FixtureExpectation {
  name: string;
  description: string;
  question: string;
  rubricVersion: string;
  // 'plan' (default) or 'build'. Selects which agent runs and which
  // rubric the loader validates against.
  phase: FixturePhase;
  mode?: RubricMode; // required on v2.0+
  seniority?: FixtureSeniority; // defaults to 'senior' in the runner
  planMd: string | null;
  hints?: FixtureHint[];
  // Build-phase only. events.jsonl is reconstructed into a final tree;
  // ai-turns.jsonl is selected down to the recent K turns by the same
  // selectBuildContext helper the orchestrator uses.
  events?: FixtureBuildEvent[];
  aiTurns?: FixtureAITurn[];
  buildStartedAt?: string;
  buildEndedAt?: string;
}

export interface SignalMismatch {
  signalId: string;
  expectedMode: SignalMode;
  actualResult: 'hit' | 'partial' | 'miss' | 'cannot_evaluate' | 'not_returned';
  actualEvidence: string;
}

export interface FixtureResult {
  name: string;
  description: string;
  pass: boolean;
  scoreOk: boolean;
  signalsOk: boolean;
  actualScore: number;
  expectedScore: { min: number; max: number };
  signalsExpected: number;
  signalsMet: number;
  mismatches: SignalMismatch[];
  warnOnly: boolean;
  elapsedMs: number;
  modelUsed: string;
}

export interface SuiteReport {
  results: FixtureResult[];
  totalElapsedMs: number;
  provider: string;
  model: string;
  rubricVersion: string;
}
