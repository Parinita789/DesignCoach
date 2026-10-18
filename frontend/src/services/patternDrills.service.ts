import { api } from './api';
import { DrillAnswer, ManualStatus, PatternDrillSet } from '@/types/patternDrill';

export const patternDrillsService = {
  // No input needed — the backend picks patterns from your own history
  // (least-practiced first).
  generate() {
    return api.post<PatternDrillSet>('/pattern-drills').then((r) => r.data);
  },
  get(id: string) {
    return api.get<PatternDrillSet>(`/pattern-drills/${encodeURIComponent(id)}`).then((r) => r.data);
  },
  list() {
    return api.get<PatternDrillSet[]>('/pattern-drills').then((r) => r.data);
  },
  submit(id: string, answers: DrillAnswer[]) {
    return api
      .post<PatternDrillSet>(`/pattern-drills/${encodeURIComponent(id)}/submit`, { answers })
      .then((r) => r.data);
  },
  delete(id: string) {
    return api
      .delete<{ ok: true }>(`/pattern-drills/${encodeURIComponent(id)}`)
      .then((r) => r.data);
  },
  setStatus(id: string, itemId: string, status: ManualStatus) {
    return api
      .patch<PatternDrillSet>(`/pattern-drills/${encodeURIComponent(id)}/status`, { itemId, status })
      .then((r) => r.data);
  },
};
