import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ClaudeCodeLogReader,
  encodedCwd,
  parseClaudeCodeLine,
  TEXT_CAP,
  TOOL_RESULT_CAP,
} from './aiLogs';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-aiLogs-'));
}

function writeJsonl(file: string, entries: object[]): void {
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

describe('encodedCwd', () => {
  it("matches Claude Code's leading-dash convention", () => {
    expect(encodedCwd('/Users/parinita/Desktop/projects/Foo')).toBe(
      '-Users-parinita-Desktop-projects-Foo',
    );
  });
});

describe('parseClaudeCodeLine', () => {
  it('parses a plain user-text turn', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-05-07T00:00:00Z',
      message: { role: 'user', content: 'implement auth' },
    });
    const out = parseClaudeCodeLine(line, 'cc-1', 0);
    expect(out).toMatchObject({
      tool: 'claude-code',
      externalSessionId: 'cc-1',
      turnIndex: 0,
      role: 'user',
      text: 'implement auth',
      toolName: null,
    });
  });

  it('truncates long text fields', () => {
    const big = 'x'.repeat(TEXT_CAP + 100);
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-07T00:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: big }] },
    });
    const out = parseClaudeCodeLine(line, 'cc-1', 0);
    expect(out!.text).toMatch(/\[\+ 100 chars truncated\]$/);
    expect(out!.text!.length).toBeLessThan(TEXT_CAP + 50);
  });

  it('promotes role to tool_use and summarizes Read', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-07T00:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading the file' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x/y.ts' } },
        ],
      },
    });
    const out = parseClaudeCodeLine(line, 'cc-1', 5);
    expect(out!.role).toBe('tool_use');
    expect(out!.toolName).toBe('Read');
    expect(out!.toolInputSummary).toBe('read /x/y.ts');
  });

  it('promotes role to tool_result and truncates result text', () => {
    const big = 'A'.repeat(TOOL_RESULT_CAP + 50);
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-05-07T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: big }],
      },
    });
    const out = parseClaudeCodeLine(line, 'cc-1', 7);
    expect(out!.role).toBe('tool_result');
    expect(out!.toolResultSummary).toMatch(/\[\+ 50 chars truncated\]$/);
  });

  it('summarizes Bash + WebFetch tools', () => {
    const bash = parseClaudeCodeLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-07T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }],
        },
      }),
      'cc-1',
      0,
    );
    expect(bash!.toolInputSummary).toBe('bash | ls -la');

    const fetch = parseClaudeCodeLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-07T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } }],
        },
      }),
      'cc-1',
      0,
    );
    expect(fetch!.toolInputSummary).toBe('webfetch https://example.com');
  });

  it('returns null for unparseable lines', () => {
    expect(parseClaudeCodeLine('not json', 'cc-1', 0)).toBeNull();
    expect(parseClaudeCodeLine('{}', 'cc-1', 0)).toBeNull();
  });
});

describe('ClaudeCodeLogReader.scan', () => {
  function makeReader(opts: {
    projectDir?: string;
    cursorDir?: string;
    buildStartedAt?: Date;
  } = {}) {
    const cursorDir = opts.cursorDir ?? tmpDir();
    const projectDir = opts.projectDir ?? tmpDir();
    const reader = new ClaudeCodeLogReader({
      cwd: '/fake/cwd',
      buildStartedAt: opts.buildStartedAt ?? new Date(0),
      cursorDir,
      projectDirOverride: projectDir,
    });
    return { reader, cursorDir, projectDir };
  }

  it('returns [] when the project dir does not exist', async () => {
    const reader = new ClaudeCodeLogReader({
      cwd: '/nope',
      buildStartedAt: new Date(0),
      cursorDir: tmpDir(),
      projectDirOverride: '/path/that/does/not/exist',
    });
    const out = await reader.scan();
    expect(out).toEqual([]);
  });

  it('reads turns from a single JSONL file', async () => {
    const { reader, projectDir } = makeReader();
    writeJsonl(path.join(projectDir, 'cc-1.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-05-07T00:00:00Z',
        message: { role: 'user', content: 'plan it' },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-07T00:00:01Z',
        message: { role: 'assistant', content: 'sure' },
      },
    ]);
    const out = await reader.scan();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ externalSessionId: 'cc-1', turnIndex: 0, role: 'user' });
    expect(out[1]).toMatchObject({ externalSessionId: 'cc-1', turnIndex: 1, role: 'assistant' });
  });

  it('cursor advances; second scan returns empty', async () => {
    const { reader, projectDir } = makeReader();
    writeJsonl(path.join(projectDir, 'cc-1.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-05-07T00:00:00Z',
        message: { role: 'user', content: 'hi' },
      },
    ]);
    expect(await reader.scan()).toHaveLength(1);
    expect(await reader.scan()).toHaveLength(0);
  });

  it('picks up newly appended lines on the second scan', async () => {
    const { reader, projectDir } = makeReader();
    const file = path.join(projectDir, 'cc-1.jsonl');
    writeJsonl(file, [
      {
        type: 'user',
        timestamp: '2026-05-07T00:00:00Z',
        message: { role: 'user', content: 'first' },
      },
    ]);
    expect(await reader.scan()).toHaveLength(1);
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-07T00:00:01Z',
        message: { role: 'assistant', content: 'second' },
      }) + '\n',
    );
    const out = await reader.scan();
    expect(out).toHaveLength(1);
    expect(out[0].turnIndex).toBe(1);
    expect(out[0].text).toBe('second');
  });

  it('skips files whose first turn predates buildStartedAt', async () => {
    const { reader, projectDir } = makeReader({
      buildStartedAt: new Date('2026-05-07T00:00:00Z'),
    });
    writeJsonl(path.join(projectDir, 'pre-build.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-05-06T00:00:00Z',
        message: { role: 'user', content: 'old session' },
      },
    ]);
    writeJsonl(path.join(projectDir, 'during-build.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-05-07T00:00:01Z',
        message: { role: 'user', content: 'in scope' },
      },
    ]);
    const out = await reader.scan();
    expect(out).toHaveLength(1);
    expect(out[0].externalSessionId).toBe('during-build');
  });

  it('tolerates unparseable lines without losing the rest', async () => {
    const { reader, projectDir } = makeReader();
    fs.writeFileSync(
      path.join(projectDir, 'cc-1.jsonl'),
      ['{"garbage', JSON.stringify({
        type: 'user',
        timestamp: '2026-05-07T00:00:00Z',
        message: { role: 'user', content: 'survived' },
      })].join('\n') + '\n',
      'utf-8',
    );
    const out = await reader.scan();
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('survived');
  });

  it('does not parse the trailing partial line; advances on next scan after newline arrives', async () => {
    const { reader, projectDir } = makeReader();
    const file = path.join(projectDir, 'cc-1.jsonl');
    // Write a complete first line + a partial second line (no trailing newline).
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-07T00:00:00Z',
        message: { role: 'user', content: 'first' },
      }) + '\n' + '{"type":"user","timesta',
      'utf-8',
    );
    expect(await reader.scan()).toHaveLength(1);
    // Now finish the second line.
    fs.appendFileSync(
      file,
      'mp":"2026-05-07T00:00:01Z","message":{"role":"user","content":"second"}}\n',
    );
    const out = await reader.scan();
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('second');
    expect(out[0].turnIndex).toBe(1);
  });
});
