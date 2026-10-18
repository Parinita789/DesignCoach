import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import { PatternDrillBankService } from './pattern-drill-bank.service';

describe('PatternDrillBankService — real bank.yaml', () => {
  let service: PatternDrillBankService;

  beforeEach(async () => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'patternDrill.bankPath') {
          return path.join(__dirname, '..', '..', '..', '..', 'pattern-drills', 'bank.yaml');
        }
        return undefined;
      }),
    } as unknown as ConfigService;
    service = new PatternDrillBankService(config);
    await service.reload();
  });

  it('throws if all() is called before reload()', () => {
    const unloaded = new PatternDrillBankService({ get: jest.fn() } as unknown as ConfigService);
    expect(() => unloaded.all()).toThrow(/not loaded/);
  });

  it('loads at least one item per seeded pattern', () => {
    const items = service.all();
    expect(items.length).toBeGreaterThan(0);
    const patterns = new Set(items.map((i) => i.pattern));
    for (const p of [
      'two_pointers',
      'hashmap_set',
      'sliding_window',
      'prefix_sum',
      'modified_binary_search',
    ] as const) {
      expect(patterns.has(p)).toBe(true);
    }
  });

  it('every item has non-empty statement, triggerPhrase, and firstMove', () => {
    for (const item of service.all()) {
      expect(item.statement.trim().length).toBeGreaterThan(0);
      expect(item.triggerPhrase.trim().length).toBeGreaterThan(0);
      expect(item.firstMove.trim().length).toBeGreaterThan(0);
    }
  });

  it('item ids are unique', () => {
    const ids = service.all().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('filters by pattern via byPattern()', () => {
    const twoPointerItems = service.byPattern('two_pointers');
    expect(twoPointerItems.length).toBeGreaterThan(0);
    expect(twoPointerItems.every((i) => i.pattern === 'two_pointers')).toBe(true);
  });

  it('includes the subarray-sum-equals-k / sliding_window boundary pair', () => {
    const item = service.all().find((i) => i.id === 'prefix_sum-subarray-sum-equals-k');
    expect(item?.boundaryPairWith).toEqual(['sliding_window']);
  });

  it('flags the sorted two-sum item as confusable with both binary search and hashmap', () => {
    const item = service.all().find((i) => i.id === 'two_pointers-sorted-two-sum');
    expect(item?.boundaryPairWith).toEqual(['modified_binary_search', 'hashmap_set']);
  });

  it('every seeded pattern with content has at least one hard item', () => {
    const items = service.all();
    const patternsWithContent = new Set(items.map((i) => i.pattern));
    for (const pattern of patternsWithContent) {
      const hasHard = items.some((i) => i.pattern === pattern && i.difficulty === 'hard');
      expect(hasHard).toBe(true);
    }
  });

  it('has no invalid difficulty values', () => {
    for (const item of service.all()) {
      if (item.difficulty !== undefined) {
        expect(['easy', 'medium', 'hard']).toContain(item.difficulty);
      }
    }
  });
});
