// Mirrors backend/src/modules/pattern-drills/types/pattern-drill.types.ts.
// Ordered to match the user's study-plan sequence (W1 -> W8+).
export const PATTERN_IDS = [
  'two_pointers',
  'hashmap_set',
  'sliding_window',
  'prefix_sum',
  'modified_binary_search',
  'fast_slow_pointers',
  'linked_list_reversal',
  'monotonic_stack',
  'top_k_heap',
  'overlapping_intervals',
  'binary_tree_traversal',
  'dfs',
  'bfs',
  'matrix_traversal',
  'backtracking',
  'dynamic_programming',
] as const;

export type PatternId = (typeof PATTERN_IDS)[number];

export const PATTERN_LABELS: Record<PatternId, string> = {
  two_pointers: 'Two pointers',
  hashmap_set: 'Hashmap / Set',
  sliding_window: 'Sliding window',
  prefix_sum: 'Prefix sum',
  modified_binary_search: 'Modified binary search',
  fast_slow_pointers: 'Fast & slow pointers',
  linked_list_reversal: 'Linked-list in-place reversal',
  monotonic_stack: 'Monotonic stack',
  top_k_heap: 'Top-k (heap)',
  overlapping_intervals: 'Overlapping intervals',
  binary_tree_traversal: 'Binary tree traversal',
  dfs: 'DFS',
  bfs: 'BFS',
  matrix_traversal: 'Matrix traversal',
  backtracking: 'Backtracking',
  dynamic_programming: 'Dynamic programming',
};

export interface DrillSetItem {
  itemId: string;
  statement: string;
}

export const MANUAL_STATUSES = ['pending', 'in_progress', 'solved'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export const MANUAL_STATUS_LABELS: Record<ManualStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  solved: 'Solved',
};

export interface DrillItemGrade {
  itemId: string;
  pattern: PatternId;
  patternCorrect: boolean;
  triggerPhraseAcceptable: boolean;
  correct: boolean;
  explanation: string;
}

export interface DrillAnswer {
  itemId: string;
  pattern: PatternId | '';
  triggerPhrase: string;
  firstMove: string;
}

export interface PatternDrillSet {
  id: string;
  userId: string;
  createdAt: string;
  coveredPatterns: PatternId[];
  items: DrillSetItem[];
  submission: DrillAnswer[] | null;
  gradedResult: DrillItemGrade[] | null;
  submittedAt: string | null;
  isOutstanding?: boolean;
  manualStatus: Record<string, ManualStatus> | null;
}
