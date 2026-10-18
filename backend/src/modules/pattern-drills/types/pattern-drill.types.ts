// Ordered to match the user's study-plan sequence (W1 -> W8+). Patterns
// without bank content yet just never get selected until bank.yaml grows.
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

// Not shown to the candidate before submission (would hint at how hard the
// problem is, which leaks alongside the pattern). Drives weighted selection
// in selectItemsByHistory — hard problems are picked more often, per the
// user's "stop giving me only the generic ones" request.
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface BankItem {
  id: string;
  pattern: PatternId;
  statement: string;
  triggerPhrase: string;
  firstMove: string;
  // Missing = 'medium'. Existing foundational items predate this field;
  // new hard items are always tagged explicitly.
  difficulty?: Difficulty;
  // A problem can be confusable with more than one other pattern (e.g. the
  // sorted-array two-sum below is a trap for both "just binary search it"
  // and "just hashmap it" instincts) — list, not a single value.
  boundaryPairWith?: PatternId[];
}

export const MANUAL_STATUSES = ['pending', 'in_progress', 'solved'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

// What gets persisted on PatternDrillSet.items and returned to the client
// before submission — no canonical-answer fields, so the row itself can
// never leak the answer key.
export interface PersistedDrillItem {
  itemId: string;
  statement: string;
}

export interface DrillAnswer {
  itemId: string;
  pattern: string;
  triggerPhrase: string;
  firstMove?: string;
}

export interface DrillItemGrade {
  itemId: string;
  // The canonical pattern — safe to reveal once graded (no longer an
  // answer-key leak at this point). Drives the progress view's
  // per-pattern weak-spot aggregation.
  pattern: PatternId;
  patternCorrect: boolean;
  triggerPhraseAcceptable: boolean;
  correct: boolean;
  explanation: string;
}
