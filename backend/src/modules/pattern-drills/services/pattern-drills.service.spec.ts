import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PatternDrillsService,
  selectItemsByHistory,
  weightedPickByDifficulty,
} from './pattern-drills.service';
import { AGENTS_CONFIG } from '../../../config/llm-tunables.config';
import { SUBMIT_DRILL_GRADES_TOOL_NAME } from '../prompts/submit-drill-grades-tool-schema';
import { BankItem, PatternId } from '../types/pattern-drill.types';

const UID = 'uid-1';

const BANK: BankItem[] = [
  {
    id: 'tp-1',
    pattern: 'two_pointers',
    statement: 'tp statement',
    triggerPhrase: 'tp trigger',
    firstMove: 'tp move',
  },
  {
    id: 'tp-2',
    pattern: 'two_pointers',
    statement: 'tp2 statement',
    triggerPhrase: 'tp2 trigger',
    firstMove: 'tp2 move',
    // Confusable with both binary search AND hashmap — a real item can have
    // more than one boundary pair (see two_pointers-sorted-two-sum).
    boundaryPairWith: ['modified_binary_search', 'hashmap_set'],
  },
  {
    id: 'sw-1',
    pattern: 'sliding_window',
    statement: 'sw statement',
    triggerPhrase: 'sw trigger',
    firstMove: 'sw move',
  },
  {
    id: 'mbs-1',
    pattern: 'modified_binary_search',
    statement: 'mbs statement',
    triggerPhrase: 'mbs trigger',
    firstMove: 'mbs move',
    boundaryPairWith: ['two_pointers'],
  },
  {
    id: 'hm-1',
    pattern: 'hashmap_set',
    statement: 'hm statement',
    triggerPhrase: 'hm trigger',
    firstMove: 'hm move',
    boundaryPairWith: ['two_pointers'],
  },
  {
    id: 'stack-1',
    pattern: 'monotonic_stack',
    statement: 'stack statement',
    triggerPhrase: 'stack trigger',
    firstMove: 'stack move',
  },
];

describe('selectItemsByHistory', () => {
  it('picks from the least-attempted pattern first', () => {
    // Every available pattern gets an explicit count so there's no tie at
    // the minimum — sliding_window (0) must be the unambiguous winner.
    const counts = new Map<PatternId, number>([
      ['two_pointers', 10],
      ['sliding_window', 0],
      ['modified_binary_search', 8],
      ['hashmap_set', 8],
      ['monotonic_stack', 5],
    ]);
    const chosen = selectItemsByHistory(BANK, counts, 1, () => 0.99);
    expect(chosen[0]?.pattern).toBe('sliding_window');
  });

  it('treats never-attempted patterns (absent from the map) as lower priority than any attempted count', () => {
    const counts = new Map<PatternId, number>([
      ['two_pointers', 1],
      ['sliding_window', 1],
      ['modified_binary_search', 1],
      ['hashmap_set', 1],
      // monotonic_stack absent entirely => 0 attempts, must win.
    ]);
    const chosen = selectItemsByHistory(BANK, counts, 1, () => 0.99);
    expect(chosen[0]?.pattern).toBe('monotonic_stack');
  });

  it('fills the second slot from a boundary-pair partner of the first pick, when one has content', () => {
    // two_pointers is least-attempted; tp-2 is confusable with both
    // modified_binary_search and hashmap_set, both of which have content.
    const counts = new Map<PatternId, number>([
      ['two_pointers', 0],
      ['sliding_window', 5],
      ['modified_binary_search', 5],
      ['hashmap_set', 5],
      ['monotonic_stack', 5],
    ]);
    // BANK's two_pointers items are tp-1 (no boundary pair) then tp-2 (has
    // one), both weighted equally (no difficulty set => both 'medium').
    // random() = 0.9 lands the weighted pick on the second candidate, tp-2.
    const chosen = selectItemsByHistory(BANK, counts, 2, () => 0.9);
    const patterns = chosen.map((i) => i.pattern);
    expect(patterns).toContain('two_pointers');
    expect(patterns.some((p) => p === 'modified_binary_search' || p === 'hashmap_set')).toBe(true);
  });

  it('falls back to the next-least-attempted pattern when the first pick has no boundary partner with content', () => {
    const counts = new Map<PatternId, number>([
      ['monotonic_stack', 0], // stack-1 has no boundaryPairWith at all
      ['sliding_window', 1],
      ['two_pointers', 5],
      ['modified_binary_search', 5],
      ['hashmap_set', 5],
    ]);
    const chosen = selectItemsByHistory(BANK, counts, 2, () => 0.99);
    const patterns = chosen.map((i) => i.pattern);
    expect(patterns).toContain('monotonic_stack');
    expect(patterns).toContain('sliding_window');
  });

  it('never returns duplicate items', () => {
    const chosen = selectItemsByHistory(BANK, new Map(), BANK.length, () => Math.random());
    const ids = chosen.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('caps the result at setSize', () => {
    const chosen = selectItemsByHistory(BANK, new Map(), 2, () => 0.99);
    expect(chosen.length).toBeLessThanOrEqual(2);
  });

  it('favors hard problems within a pattern over many draws, not just an occasional one', () => {
    // Three items, one per difficulty, all the same pattern.
    const mixedBank: BankItem[] = [
      { id: 'e', pattern: 'two_pointers', statement: 's', triggerPhrase: 't', firstMove: 'f', difficulty: 'easy' },
      { id: 'm', pattern: 'two_pointers', statement: 's', triggerPhrase: 't', firstMove: 'f', difficulty: 'medium' },
      { id: 'h', pattern: 'two_pointers', statement: 's', triggerPhrase: 't', firstMove: 'f', difficulty: 'hard' },
    ];
    const counts: Record<string, number> = { e: 0, m: 0, h: 0 };
    for (let i = 0; i < 2000; i++) {
      const chosen = selectItemsByHistory(mixedBank, new Map(), 1, Math.random);
      counts[chosen[0].id] += 1;
    }
    // Weights are 1:2:4 (easy:medium:hard) => hard should clearly dominate
    // easy over enough trials, without easy ever being literally unreachable.
    expect(counts.h).toBeGreaterThan(counts.e * 2);
    expect(counts.e).toBeGreaterThan(0);
  });
});

describe('weightedPickByDifficulty', () => {
  const easy: BankItem = { id: 'e', pattern: 'two_pointers', statement: 's', triggerPhrase: 't', firstMove: 'f', difficulty: 'easy' };
  const hard: BankItem = { id: 'h', pattern: 'two_pointers', statement: 's', triggerPhrase: 't', firstMove: 'f', difficulty: 'hard' };
  const noDifficulty: BankItem = { id: 'n', pattern: 'two_pointers', statement: 's', triggerPhrase: 't', firstMove: 'f' };

  it('treats a missing difficulty as medium weight (2), not easy (1) or hard (4)', () => {
    // easy(1) + noDifficulty-as-medium(2) = 3 total. roll just past 1/3
    // should land on the second candidate (noDifficulty) if it's weighted
    // as medium(2); it would land on nothing/overflow if weighted as easy(1).
    const picked = weightedPickByDifficulty([easy, noDifficulty], () => 0.5);
    expect(picked.id).toBe('n');
  });

  it('a low roll picks the first (lowest-weight-cumulative) candidate', () => {
    const picked = weightedPickByDifficulty([easy, hard], () => 0);
    expect(picked.id).toBe('e');
  });

  it('a high roll picks the later candidate, reachable proportionally more often for hard', () => {
    // easy weight 1, hard weight 4, total 5 — roll must exceed 1/5 = 0.2 to
    // land on hard, so hard is reachable across 80% of the roll range.
    const pickedJustPastEasy = weightedPickByDifficulty([easy, hard], () => 0.21);
    expect(pickedJustPastEasy.id).toBe('h');
  });
});

describe('PatternDrillsService', () => {
  let service: PatternDrillsService;
  const repo = {
    findOutstanding: jest.fn(),
    create: jest.fn(),
    findByIdForUser: jest.fn(),
    listByUser: jest.fn(),
    markSubmitted: jest.fn(),
    delete: jest.fn(),
    findGradedResultsByUser: jest.fn(),
    updateManualStatus: jest.fn(),
  };
  const bank = { all: jest.fn(), byPattern: jest.fn() };
  const llm = { call: jest.fn(), supportsToolUse: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    bank.all.mockReturnValue(BANK);
    llm.supportsToolUse.mockReturnValue(true);
    repo.findGradedResultsByUser.mockResolvedValue([]);
    service = new PatternDrillsService(repo as never, bank as never, llm as never);
  });

  describe('generateOrGetOutstanding', () => {
    it('returns the outstanding set unchanged and flags isOutstanding', async () => {
      const outstanding = { id: 'set-1', submittedAt: null, items: [] };
      repo.findOutstanding.mockResolvedValue(outstanding);

      const result = await service.generateOrGetOutstanding(UID);

      expect(result).toEqual({ set: outstanding, isOutstanding: true });
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.findGradedResultsByUser).not.toHaveBeenCalled();
    });

    it('generates and persists a fresh set when none is outstanding, picking patterns from history', async () => {
      repo.findOutstanding.mockResolvedValue(null);
      repo.findGradedResultsByUser.mockResolvedValue([
        { gradedResult: [{ itemId: 'tp-1', pattern: 'two_pointers', correct: true }] },
      ]);
      repo.create.mockResolvedValue({ id: 'set-2', items: [{ itemId: 'tp-1', statement: 'tp statement' }] });

      const result = await service.generateOrGetOutstanding(UID);

      expect(repo.findGradedResultsByUser).toHaveBeenCalledWith(UID);
      expect(repo.create).toHaveBeenCalledTimes(1);
      const createArgs = repo.create.mock.calls[0][0];
      expect(createArgs.userId).toBe(UID);
      // Persisted items must never carry the answer-key `pattern` field.
      for (const item of createArgs.items) {
        expect(item).toEqual({ itemId: expect.any(String), statement: expect.any(String) });
      }
      expect(result.isOutstanding).toBe(false);
    });
  });

  describe('getById', () => {
    it('throws NotFoundException when the repo returns nothing', async () => {
      repo.findByIdForUser.mockResolvedValue(null);
      await expect(service.getById('missing', UID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes a set owned by the user', async () => {
      repo.findByIdForUser.mockResolvedValue({ id: 'set-1', userId: UID });
      await service.delete('set-1', UID);
      expect(repo.delete).toHaveBeenCalledWith('set-1');
    });

    it('throws NotFoundException and never deletes when the set is missing or not owned by this user', async () => {
      repo.findByIdForUser.mockResolvedValue(null);
      await expect(service.delete('set-1', UID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  describe('setManualStatus', () => {
    const setRow = {
      id: 'set-1',
      userId: UID,
      items: [{ itemId: 'tp-1', statement: 'tp statement' }],
      manualStatus: null,
    };

    it('sets a status for an item that belongs to the set', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      repo.updateManualStatus.mockResolvedValue({ ...setRow, manualStatus: { 'tp-1': 'in_progress' } });

      await service.setManualStatus('set-1', UID, 'tp-1', 'in_progress');

      expect(repo.updateManualStatus).toHaveBeenCalledWith('set-1', { 'tp-1': 'in_progress' });
    });

    it('merges into existing statuses rather than overwriting other items', async () => {
      repo.findByIdForUser.mockResolvedValue({
        ...setRow,
        items: [
          { itemId: 'tp-1', statement: 'tp statement' },
          { itemId: 'tp-2', statement: 'tp2 statement' },
        ],
        manualStatus: { 'tp-1': 'solved' },
      });
      repo.updateManualStatus.mockResolvedValue({});

      await service.setManualStatus('set-1', UID, 'tp-2', 'pending');

      expect(repo.updateManualStatus).toHaveBeenCalledWith('set-1', {
        'tp-1': 'solved',
        'tp-2': 'pending',
      });
    });

    it('throws BadRequestException when the item is not part of this set', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      await expect(
        service.setManualStatus('set-1', UID, 'not-in-set', 'solved'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateManualStatus).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the set is missing or not owned by this user', async () => {
      repo.findByIdForUser.mockResolvedValue(null);
      await expect(
        service.setManualStatus('set-1', UID, 'tp-1', 'solved'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updateManualStatus).not.toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    const setRow = {
      id: 'set-1',
      submittedAt: null,
      items: [{ itemId: 'tp-1', statement: 'tp statement' }],
    };

    it('throws BadRequestException if the set was already submitted', async () => {
      repo.findByIdForUser.mockResolvedValue({ ...setRow, submittedAt: new Date() });
      await expect(
        service.submit('set-1', UID, [
          { itemId: 'tp-1', pattern: 'two_pointers', triggerPhrase: 'x', firstMove: 'y' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when an answer references an item outside this set', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      await expect(
        service.submit('set-1', UID, [
          { itemId: 'not-in-set', pattern: 'two_pointers', triggerPhrase: 'x', firstMove: 'y' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('calls the LLM with the drill-grading tool and persists the deterministic verdict', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      llm.call.mockResolvedValue({
        text: '',
        toolUse: {
          name: SUBMIT_DRILL_GRADES_TOOL_NAME,
          input: {
            'tp-1': {
              patternCorrect: true,
              triggerPhraseAcceptable: false,
              explanation: 'Right pattern, but your trigger phrase was just "it felt right".',
            },
          },
        },
        modelUsed: 'claude-opus-4-7',
        tokensIn: 100,
        tokensOut: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      repo.markSubmitted.mockResolvedValue({ ...setRow, submittedAt: new Date() });

      await service.submit('set-1', UID, [
        { itemId: 'tp-1', pattern: 'two_pointers', triggerPhrase: 'it felt right', firstMove: 'move inward' },
      ]);

      const [messages, opts] = llm.call.mock.calls[0];
      expect(messages[0].content).toContain('tp-1');
      expect(opts.toolChoice).toEqual({ type: 'tool', name: SUBMIT_DRILL_GRADES_TOOL_NAME });
      expect(opts.maxTokens).toBe(AGENTS_CONFIG.patternDrillGrader.maxTokens);
      expect(opts.userId).toBe(UID);
      expect(opts.route).toBe('pattern-drills.submit');

      const [, persisted] = repo.markSubmitted.mock.calls[0];
      const grade = (persisted.gradedResult as Array<{ itemId: string; correct: boolean }>)[0];
      // Right pattern + unacceptable trigger phrase must grade as incorrect,
      // regardless of how the LLM's own explanation text hedges.
      expect(grade.correct).toBe(false);
    });

    it('stamps the canonical (true) pattern onto each grade — needed for the progress view\'s per-pattern breakdown, and safe to reveal once graded', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      llm.call.mockResolvedValue({
        text: '',
        toolUse: {
          name: SUBMIT_DRILL_GRADES_TOOL_NAME,
          input: { 'tp-1': { patternCorrect: true, triggerPhraseAcceptable: true, explanation: 'Nice.' } },
        },
        modelUsed: 'claude-opus-4-7',
        tokensIn: 100,
        tokensOut: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      repo.markSubmitted.mockResolvedValue({ ...setRow, submittedAt: new Date() });

      // Candidate answers a different (wrong) pattern than the item's
      // canonical one — the stamped `pattern` field must still be the
      // canonical bank pattern ('two_pointers' for tp-1), not the guess.
      await service.submit('set-1', UID, [
        { itemId: 'tp-1', pattern: 'hashmap_set', triggerPhrase: 'x', firstMove: 'y' },
      ]);

      const [, persisted] = repo.markSubmitted.mock.calls[0];
      const grade = (persisted.gradedResult as Array<{ itemId: string; pattern: string }>)[0];
      expect(grade.pattern).toBe('two_pointers');
    });

    it('grades normally when firstMove is omitted — it is context only, never a graded field', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      llm.call.mockResolvedValue({
        text: '',
        toolUse: {
          name: SUBMIT_DRILL_GRADES_TOOL_NAME,
          input: { 'tp-1': { patternCorrect: true, triggerPhraseAcceptable: true, explanation: 'Nice.' } },
        },
        modelUsed: 'claude-opus-4-7',
        tokensIn: 100,
        tokensOut: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      repo.markSubmitted.mockResolvedValue({ ...setRow, submittedAt: new Date() });

      await service.submit('set-1', UID, [
        { itemId: 'tp-1', pattern: 'two_pointers', triggerPhrase: 'converge inward' },
      ]);

      const [messages] = llm.call.mock.calls[0];
      expect(messages[0].content).toContain('(not provided — do not penalize this)');

      const [, persisted] = repo.markSubmitted.mock.calls[0];
      const grade = (persisted.gradedResult as Array<{ itemId: string; correct: boolean }>)[0];
      expect(grade.correct).toBe(true);
    });

    it('marks an item correct only when both patternCorrect and triggerPhraseAcceptable are true', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      llm.call.mockResolvedValue({
        text: '',
        toolUse: {
          name: SUBMIT_DRILL_GRADES_TOOL_NAME,
          input: { 'tp-1': { patternCorrect: true, triggerPhraseAcceptable: true, explanation: 'Nice.' } },
        },
        modelUsed: 'claude-opus-4-7',
        tokensIn: 100,
        tokensOut: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      repo.markSubmitted.mockResolvedValue({ ...setRow, submittedAt: new Date() });

      await service.submit('set-1', UID, [
        { itemId: 'tp-1', pattern: 'two_pointers', triggerPhrase: 'converge inward', firstMove: 'move inward' },
      ]);

      const [, persisted] = repo.markSubmitted.mock.calls[0];
      const grade = (persisted.gradedResult as Array<{ itemId: string; correct: boolean }>)[0];
      expect(grade.correct).toBe(true);
    });

    it('throws when the LLM response has neither tool output nor parseable JSON', async () => {
      repo.findByIdForUser.mockResolvedValue(setRow);
      llm.call.mockResolvedValue({
        text: 'no tool call and no json here',
        modelUsed: 'claude-opus-4-7',
        tokensIn: 10,
        tokensOut: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });

      await expect(
        service.submit('set-1', UID, [
          { itemId: 'tp-1', pattern: 'two_pointers', triggerPhrase: 'x', firstMove: 'y' },
        ]),
      ).rejects.toThrow(/did not return any JSON object/);
      expect(repo.markSubmitted).not.toHaveBeenCalled();
    });

    it('falls back to parsing JSON text when the provider does not support tool use (claude_cli/ollama)', async () => {
      llm.supportsToolUse.mockReturnValue(false);
      repo.findByIdForUser.mockResolvedValue(setRow);
      llm.call.mockResolvedValue({
        text: '```json\n{"tp-1": {"patternCorrect": true, "triggerPhraseAcceptable": true, "explanation": "Nice."}}\n```',
        modelUsed: 'claude-opus-4-7',
        tokensIn: 100,
        tokensOut: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      repo.markSubmitted.mockResolvedValue({ ...setRow, submittedAt: new Date() });

      await service.submit('set-1', UID, [
        { itemId: 'tp-1', pattern: 'two_pointers', triggerPhrase: 'converge inward', firstMove: 'move inward' },
      ]);

      const [, opts] = llm.call.mock.calls[0];
      expect(opts.tools).toBeUndefined();
      expect(opts.toolChoice).toBeUndefined();

      const [, persisted] = repo.markSubmitted.mock.calls[0];
      const grade = (persisted.gradedResult as Array<{ itemId: string; correct: boolean }>)[0];
      expect(grade.correct).toBe(true);
    });
  });
});
