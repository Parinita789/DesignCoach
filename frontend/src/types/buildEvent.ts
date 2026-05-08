export interface MintedBuildToken {
  token: string;
  sessionId: string;
  expiresInMinutes: number;
  buildStartedAt: string;
}

export interface BuildEventsPerFile {
  filePath: string;
  eventCount: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface BuildEventsSummary {
  buildStartedAt: string | null;
  buildEndedAt: string | null;
  eventCount: number;
  perFile: BuildEventsPerFile[];
  aiInteractionCount: number;
  aiSessionsCount: number;
}
