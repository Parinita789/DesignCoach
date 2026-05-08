import { createPatch } from 'diff';
import { reconstructBuildTree, BuildEventForTree } from './reconstruct-build-tree';

function event(
  filePath: string,
  action: string,
  occurredAt: string,
  content: string | null = null,
  contentDiff: string | null = null,
): BuildEventForTree {
  return {
    filePath,
    action,
    content,
    contentDiff,
    occurredAt: new Date(occurredAt),
  };
}

describe('reconstructBuildTree', () => {
  it('returns an empty tree when no events', () => {
    const out = reconstructBuildTree([]);
    expect(out.tree).toEqual([]);
    expect(out.brokenPatchPaths).toEqual([]);
  });

  it('builds a tree from create-only events', () => {
    const events = [
      event('a.ts', 'created', '2026-05-07T10:00:00Z', 'export const a = 1;'),
      event('b.ts', 'created', '2026-05-07T10:01:00Z', 'export const b = 2;'),
    ];
    const { tree, contents } = reconstructBuildTree(events);
    expect(tree.map((t) => t.path)).toEqual(['a.ts', 'b.ts']);
    expect(contents.get('a.ts')).toBe('export const a = 1;');
    expect(tree[0].size).toBe(Buffer.byteLength('export const a = 1;', 'utf-8'));
    expect(tree[0].sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('applies a content diff to evolve a file', () => {
    const v1 = 'export const a = 1;\n';
    const v2 = 'export const a = 2;\n';
    const patch = createPatch('a.ts', v1, v2, '', '', { context: 3 });

    const events = [
      event('a.ts', 'created', '2026-05-07T10:00:00Z', v1),
      event('a.ts', 'modified', '2026-05-07T10:05:00Z', null, patch),
    ];
    const { contents, brokenPatchPaths } = reconstructBuildTree(events);
    expect(contents.get('a.ts')).toBe(v2);
    expect(brokenPatchPaths).toEqual([]);
  });

  it('records broken patches without aborting the rest of the tree', () => {
    const events = [
      event('a.ts', 'created', '2026-05-07T10:00:00Z', 'one\ntwo\nthree\n'),
      event(
        'a.ts',
        'modified',
        '2026-05-07T10:05:00Z',
        null,
        '@@ -1,3 +1,3 @@\n-NOPE\n+CHANGED\n two\n three\n',
      ),
      event('b.ts', 'created', '2026-05-07T10:06:00Z', 'export const b = 1;'),
    ];
    const { tree, contents, brokenPatchPaths } = reconstructBuildTree(events);
    expect(brokenPatchPaths).toEqual(['a.ts']);
    expect(contents.get('a.ts')).toBe('one\ntwo\nthree\n');
    expect(tree.map((t) => t.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('handles delete then re-create', () => {
    const events = [
      event('a.ts', 'created', '2026-05-07T10:00:00Z', 'first'),
      event('a.ts', 'deleted', '2026-05-07T10:01:00Z'),
      event('a.ts', 'created', '2026-05-07T10:02:00Z', 'second'),
    ];
    const { contents, tree } = reconstructBuildTree(events);
    expect(contents.get('a.ts')).toBe('second');
    expect(tree).toHaveLength(1);
  });

  it('flags a diff against an unknown path as broken (no prior content)', () => {
    const events = [
      event(
        'mystery.ts',
        'modified',
        '2026-05-07T10:00:00Z',
        null,
        '@@ -1 +1 @@\n-x\n+y\n',
      ),
    ];
    const { tree, brokenPatchPaths } = reconstructBuildTree(events);
    expect(tree).toEqual([]);
    expect(brokenPatchPaths).toEqual(['mystery.ts']);
  });

  it('orders by occurredAt regardless of input order', () => {
    const v1 = 'a\n';
    const v2 = 'b\n';
    const patch = createPatch('x.ts', v1, v2, '', '', { context: 3 });
    const events = [
      event('x.ts', 'modified', '2026-05-07T10:05:00Z', null, patch),
      event('x.ts', 'created', '2026-05-07T10:00:00Z', v1),
    ];
    const { contents, brokenPatchPaths } = reconstructBuildTree(events);
    expect(contents.get('x.ts')).toBe(v2);
    expect(brokenPatchPaths).toEqual([]);
  });

  it('sorts the output tree by path', () => {
    const events = [
      event('z.ts', 'created', '2026-05-07T10:00:00Z', 'z'),
      event('a.ts', 'created', '2026-05-07T10:01:00Z', 'a'),
      event('m.ts', 'created', '2026-05-07T10:02:00Z', 'm'),
    ];
    const { tree } = reconstructBuildTree(events);
    expect(tree.map((t) => t.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});
