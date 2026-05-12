import { spawn } from 'node:child_process';
import {
  CriticLlmCallParams,
  CriticLlmClient,
  CriticLlmResponse,
  Semaphore,
} from './llm-client';

// Mirrors the mapper's MapperClaudeCliClient. Two differences:
//
//   1. Larger default max_tokens (reviews are bigger than the
//      mapper's 80-word responsibility paragraphs).
//   2. When a `tool` is supplied with toolChoice='force', the CLI
//      can't actually force tool_use. Instead we inline the JSON
//      schema in the prompt, instruct the model to wrap its output
//      in <json>...</json> fences, and parse the JSON post-hoc.
//      The caller still gets `toolInput` populated when parsing
//      succeeds.

const DEFAULT_BIN = 'claude';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 3;

interface ClaudeCliEnvelope {
  type?: string;
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface ClaudeCliClientOptions {
  bin?: string;
  timeoutMs?: number;
  concurrency?: number;
  spawner?: typeof spawn;
}

export class CriticClaudeCliClient implements CriticLlmClient {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly sem: Semaphore;
  private readonly spawner: typeof spawn;

  constructor(opts: ClaudeCliClientOptions = {}) {
    this.bin = opts.bin ?? process.env.CLAUDE_CLI_BIN ?? DEFAULT_BIN;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sem = new Semaphore(opts.concurrency ?? DEFAULT_CONCURRENCY);
    this.spawner = opts.spawner ?? spawn;
  }

  async call(params: CriticLlmCallParams): Promise<CriticLlmResponse> {
    await this.sem.acquire();
    try {
      const forceTool = params.tool && params.toolChoice === 'force';
      const systemPrompt = forceTool
        ? params.systemPrompt.trim() +
          '\n\n' +
          buildToolFenceInstruction(params.tool!)
        : params.systemPrompt.trim();

      // `claude -p` has no structured system parameter; inline the
      // system content above the user prompt with a visible separator.
      const prompt = systemPrompt + '\n\n---\n\n' + params.userPrompt.trim();

      const args = [
        '-p',
        '--output-format',
        'json',
        ...(params.model ? ['--model', params.model] : []),
      ];

      const envelope = await this.spawnAndCollect(args, prompt);
      const rawText = (envelope.result ?? '').trim();
      const usage = envelope.usage ?? {};

      const toolInput = forceTool ? parseFencedJson(rawText) : undefined;

      return {
        text: toolInput ? JSON.stringify(toolInput) : rawText,
        toolInput,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      };
    } finally {
      this.sem.release();
    }
  }

  private spawnAndCollect(args: string[], stdinContent: string): Promise<ClaudeCliEnvelope> {
    return new Promise((resolve, reject) => {
      const child = this.spawner(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`claude CLI spawn failed (${this.bin}): ${err.message}`));
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `claude CLI timed out after ${this.timeoutMs}ms (prompt=${stdinContent.length} chars)`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `claude CLI exited with code ${code}: ${stderr.slice(0, 500) || '(empty stderr)'}`,
            ),
          );
          return;
        }
        let envelope: ClaudeCliEnvelope;
        try {
          envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
        } catch (err) {
          reject(
            new Error(
              `claude CLI returned non-JSON stdout: ${(err as Error).message}. ` +
                `First 500 chars: ${stdout.slice(0, 500)}`,
            ),
          );
          return;
        }
        if (envelope.is_error) {
          reject(
            new Error(
              `claude CLI returned an error envelope: ${envelope.result || '(no message)'}`,
            ),
          );
          return;
        }
        resolve(envelope);
      });

      child.stdin?.write(stdinContent);
      child.stdin?.end();
    });
  }
}

function buildToolFenceInstruction(tool: { name: string; inputSchema: Record<string, unknown> }): string {
  return [
    `You MUST respond with a single JSON object wrapped in <json>...</json> fences.`,
    `The object must conform to this JSON schema (the tool is named "${tool.name}"):`,
    '',
    JSON.stringify(tool.inputSchema, null, 2),
    '',
    `Do not include any prose outside the fences. Do not include backticks.`,
  ].join('\n');
}

// Recover JSON from any of the wrappers Claude is likely to emit:
//   <json>...</json>
//   ```json\n...\n```
//   ```\n...\n```
//   bare JSON object as the whole body
// Returns undefined on parse failure; caller treats that as
// "no tool_input emitted" and either retries or surfaces the error.
export function parseFencedJson(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];

  const xmlFence = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (xmlFence) candidates.push(xmlFence[1]);

  const jsonFence = text.match(/```json\s*\n?([\s\S]*?)\n?```/i);
  if (jsonFence) candidates.push(jsonFence[1]);

  const anyFence = text.match(/```\s*\n?([\s\S]*?)\n?```/);
  if (anyFence) candidates.push(anyFence[1]);

  // Last resort: try the whole body. Useful when the model just
  // returns the bare JSON object with no wrapper.
  candidates.push(text);

  for (const body of candidates) {
    try {
      const parsed = JSON.parse(body.trim()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
