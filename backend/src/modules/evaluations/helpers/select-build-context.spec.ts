import { selectBuildContext } from './select-build-context';

describe('selectBuildContext', () => {
  it('picks top high-churn files (max 5) and caps content', () => {
    const contents = new Map<string, string>();
    contents.set('a.ts', 'A'.repeat(100));
    contents.set('b.ts', 'B'.repeat(100));
    contents.set('c.ts', 'C'.repeat(100));
    contents.set('d.ts', 'D'.repeat(5000));
    contents.set('e.ts', 'E'.repeat(100));
    contents.set('f.ts', 'F'.repeat(100));
    contents.set('g.ts', 'G'.repeat(100));

    const churn = (path: string, len: number) => ({
      filePath: path,
      action: 'modified',
      contentDiff: 'x'.repeat(len),
      occurredAt: new Date(),
    });
    const events = [
      churn('a.ts', 1000),
      churn('b.ts', 5000),
      churn('c.ts', 200),
      churn('d.ts', 9000),
      churn('e.ts', 50),
      churn('f.ts', 500),
      churn('g.ts', 2000),
    ];

    const { keyFileSnippets } = selectBuildContext({ events, aiTurns: [], contents });
    expect(keyFileSnippets.map((s) => s.path)).toEqual(['d.ts', 'b.ts', 'g.ts', 'a.ts', 'f.ts']);
    expect(keyFileSnippets[0].content).toContain('truncated');
    expect(keyFileSnippets[0].content.length).toBeLessThan(5000);
  });

  it('uses 0 churn for files that only ship full content (created without diff)', () => {
    const contents = new Map<string, string>([['only.ts', 'full content']]);
    const { keyFileSnippets } = selectBuildContext({
      events: [],
      aiTurns: [],
      contents,
    });
    expect(keyFileSnippets).toHaveLength(1);
    expect(keyFileSnippets[0].content).toBe('full content');
  });

  it('keeps the most recent 40 AI turns and reverses them to chronological', () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({
      externalSessionId: 'cc',
      turnIndex: i,
      role: 'user',
      text: `t${i}`,
      toolName: null,
      toolInputSummary: null,
      toolResultSummary: null,
      occurredAt: new Date(`2026-05-07T10:00:${String(i).padStart(2, '0')}Z`),
    }));
    const { aiTurnsForPrompt } = selectBuildContext({
      events: [],
      aiTurns: turns,
      contents: new Map(),
    });
    expect(aiTurnsForPrompt).toHaveLength(40);
    expect(aiTurnsForPrompt[0].turnIndex).toBe(20);
    expect(aiTurnsForPrompt[39].turnIndex).toBe(59);
  });

  it('caps long AI turn text', () => {
    const long = 'x'.repeat(3000);
    const turns = [
      {
        externalSessionId: 'cc',
        turnIndex: 0,
        role: 'user',
        text: long,
        toolName: null,
        toolInputSummary: null,
        toolResultSummary: null,
        occurredAt: new Date('2026-05-07T10:00:00Z'),
      },
    ];
    const { aiTurnsForPrompt } = selectBuildContext({
      events: [],
      aiTurns: turns,
      contents: new Map(),
    });
    expect(aiTurnsForPrompt[0].text!.length).toBeLessThan(3000);
    expect(aiTurnsForPrompt[0].text).toContain('truncated');
  });

  it('normalises unknown roles to tool', () => {
    const turns = [
      {
        externalSessionId: 'cc',
        turnIndex: 0,
        role: 'system',
        text: 'irrelevant',
        toolName: null,
        toolInputSummary: null,
        toolResultSummary: null,
        occurredAt: new Date(),
      },
    ];
    const { aiTurnsForPrompt } = selectBuildContext({
      events: [],
      aiTurns: turns,
      contents: new Map(),
    });
    expect(aiTurnsForPrompt[0].role).toBe('tool');
  });
});
