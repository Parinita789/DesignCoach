import { api } from './api';
import { BuildEventsSummary, MintedBuildToken } from '@/types/buildEvent';

export const buildSessionsService = {
  startBuild(sessionId: string): Promise<MintedBuildToken> {
    return api
      .post<MintedBuildToken>(`/sessions/${sessionId}/start-build`)
      .then((r) => r.data);
  },
  eventsSummary(sessionId: string): Promise<BuildEventsSummary> {
    return api
      .get<BuildEventsSummary>(`/sessions/${sessionId}/build-events`)
      .then((r) => r.data);
  },
};
