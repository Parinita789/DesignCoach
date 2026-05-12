import { parseFencedJson } from './claude-cli-client';

describe('parseFencedJson', () => {
  const obj = { a: 1, b: { c: 'two' }, d: [1, 2] };

  it('parses <json>...</json>', () => {
    const text = `Here is the result:\n<json>${JSON.stringify(obj)}</json>\nDone.`;
    expect(parseFencedJson(text)).toEqual(obj);
  });

  it('parses ```json\\n...\\n```', () => {
    const text = `Some prose first.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
    expect(parseFencedJson(text)).toEqual(obj);
  });

  it('parses bare ```\\n...\\n``` code fences', () => {
    const text = `\`\`\`\n${JSON.stringify(obj)}\n\`\`\``;
    expect(parseFencedJson(text)).toEqual(obj);
  });

  it('parses bare JSON without any fence', () => {
    expect(parseFencedJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('returns undefined for unparseable garbage', () => {
    expect(parseFencedJson('this is not json at all')).toBeUndefined();
  });

  it('returns undefined for a JSON array (we only accept objects)', () => {
    expect(parseFencedJson('[1, 2, 3]')).toBeUndefined();
  });

  it('prefers <json> fence over later ```json``` if both present', () => {
    // The first-match-wins behavior is what the implementation
    // currently guarantees by checking <json> before ```json```.
    const text = `<json>${JSON.stringify({ first: true })}</json>\n\n\`\`\`json\n${JSON.stringify({ second: true })}\n\`\`\``;
    expect(parseFencedJson(text)).toEqual({ first: true });
  });
});
