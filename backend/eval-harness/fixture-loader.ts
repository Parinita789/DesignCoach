import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  Fixture,
  FixtureAITurn,
  FixtureBuildEvent,
  FixtureExpectation,
  FixtureHint,
  FixturePhase,
  FixtureSeniority,
  RubricMode,
  SignalMode,
} from './types';

const VALID_MODES: SignalMode[] = ['hit', 'partial', 'miss', 'credited', 'skipped'];
const VALID_RUBRIC_MODES: RubricMode[] = ['build', 'design'];
const VALID_SENIORITIES: FixtureSeniority[] = ['junior', 'mid', 'senior', 'staff'];
const VALID_PHASES: FixturePhase[] = ['plan', 'build'];

interface RawFixtureYaml {
  description?: string;
  question?: string;
  rubricVersion?: string;
  phase?: string;
  mode?: string;
  seniority?: string;
  expectedScore?: { min?: number; max?: number };
  expectedSignals?: Partial<Record<string, string[]>>;
  warnOnly?: boolean;
  hints?: Array<{
    occurredAt?: string;
    elapsedMinutes?: number;
    prompt?: string;
    response?: string;
  }>;
  buildStartedAt?: string;
  buildEndedAt?: string;
}

export function loadFixtures(rootDir: string, filter?: string): Fixture[] {
  const dirs = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !filter || name.includes(filter))
    .sort();

  if (dirs.length === 0) {
    throw new Error(
      `No fixtures matched filter=${filter ?? '(none)'} in ${rootDir}`,
    );
  }

  return dirs.map((name) => loadOne(rootDir, name));
}

function loadOne(rootDir: string, name: string): Fixture {
  const dir = path.join(rootDir, name);
  const yamlPath = path.join(dir, 'fixture.yaml');
  const planPath = path.join(dir, 'plan.md');

  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Fixture ${name} is missing fixture.yaml at ${yamlPath}`);
  }
  if (!fs.existsSync(planPath)) {
    throw new Error(`Fixture ${name} is missing plan.md at ${planPath}`);
  }

  const raw = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as RawFixtureYaml | null;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Fixture ${name}: fixture.yaml did not parse to an object`);
  }

  const description = requireString(raw.description, `${name}.description`);
  const question = requireString(raw.question, `${name}.question`);
  const rubricVersion = requireString(raw.rubricVersion, `${name}.rubricVersion`);
  const expectedScore = parseScoreRange(raw.expectedScore, name);
  const expectedSignals = parseExpectedSignals(raw.expectedSignals, name);

  // phase defaults to 'plan' for back-compat with existing fixtures.
  let phase: FixturePhase = 'plan';
  if (raw.phase !== undefined) {
    if (!VALID_PHASES.includes(raw.phase as FixturePhase)) {
      throw new Error(
        `${name}: phase "${raw.phase}" must be one of: ${VALID_PHASES.join(', ')}`,
      );
    }
    phase = raw.phase as FixturePhase;
  }

  let mode: RubricMode | undefined;
  if (raw.mode !== undefined) {
    if (!VALID_RUBRIC_MODES.includes(raw.mode as RubricMode)) {
      throw new Error(
        `${name}: mode "${raw.mode}" must be one of: ${VALID_RUBRIC_MODES.join(', ')}`,
      );
    }
    mode = raw.mode as RubricMode;
  } else if (rubricVersion !== 'v1.0') {
    throw new Error(
      `${name}: mode is required when rubricVersion is "${rubricVersion}" (v2.0+ rubrics)`,
    );
  }

  let seniority: FixtureSeniority | undefined;
  if (raw.seniority !== undefined) {
    if (!VALID_SENIORITIES.includes(raw.seniority as FixtureSeniority)) {
      throw new Error(
        `${name}: seniority "${raw.seniority}" must be one of: ${VALID_SENIORITIES.join(', ')}`,
      );
    }
    seniority = raw.seniority as FixtureSeniority;
  }

  const planMd = fs.readFileSync(planPath, 'utf8');

  const hints: FixtureHint[] | undefined = raw.hints?.map((h, i) => ({
    occurredAt: requireString(h.occurredAt, `${name}.hints[${i}].occurredAt`),
    elapsedMinutes: requireNumber(h.elapsedMinutes, `${name}.hints[${i}].elapsedMinutes`),
    prompt: requireString(h.prompt, `${name}.hints[${i}].prompt`),
    response: requireString(h.response, `${name}.hints[${i}].response`),
  }));

  let events: FixtureBuildEvent[] | undefined;
  let aiTurns: FixtureAITurn[] | undefined;
  let buildStartedAt: string | undefined;
  let buildEndedAt: string | undefined;
  if (phase === 'build') {
    const eventsPath = path.join(dir, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) {
      throw new Error(`Fixture ${name} (phase=build) is missing events.jsonl at ${eventsPath}`);
    }
    events = parseEventsJsonl(eventsPath, name);
    const aiPath = path.join(dir, 'ai-turns.jsonl');
    aiTurns = fs.existsSync(aiPath) ? parseAiTurnsJsonl(aiPath, name) : [];
    buildStartedAt = raw.buildStartedAt;
    buildEndedAt = raw.buildEndedAt;
  }

  return {
    name,
    description,
    question,
    rubricVersion,
    phase,
    mode,
    seniority,
    planMd: planMd.length > 0 ? planMd : null,
    expectedScore,
    expectedSignals,
    warnOnly: raw.warnOnly === true,
    hints,
    events,
    aiTurns,
    buildStartedAt,
    buildEndedAt,
  };
}

function parseEventsJsonl(filePath: string, name: string): FixtureBuildEvent[] {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${name}: events.jsonl line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    const action = String(row.action ?? '');
    if (action !== 'created' && action !== 'modified' && action !== 'deleted') {
      throw new Error(
        `${name}: events.jsonl line ${i + 1} action must be created/modified/deleted (got "${action}")`,
      );
    }
    return {
      filePath: requireString(row.filePath, `${name}.events[${i}].filePath`),
      action,
      content: row.content == null ? null : String(row.content),
      contentDiff: row.contentDiff == null ? null : String(row.contentDiff),
      occurredAt: requireString(row.occurredAt, `${name}.events[${i}].occurredAt`),
    };
  });
}

function parseAiTurnsJsonl(filePath: string, name: string): FixtureAITurn[] {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${name}: ai-turns.jsonl line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    const role = String(row.role ?? '');
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new Error(
        `${name}: ai-turns.jsonl line ${i + 1} role must be user/assistant/tool (got "${role}")`,
      );
    }
    return {
      externalSessionId: requireString(row.externalSessionId, `${name}.aiTurns[${i}].externalSessionId`),
      turnIndex: requireNumber(row.turnIndex, `${name}.aiTurns[${i}].turnIndex`),
      role,
      text: row.text == null ? null : String(row.text),
      toolName: row.toolName == null ? null : String(row.toolName),
      toolInputSummary: row.toolInputSummary == null ? null : String(row.toolInputSummary),
      toolResultSummary: row.toolResultSummary == null ? null : String(row.toolResultSummary),
      occurredAt: requireString(row.occurredAt, `${name}.aiTurns[${i}].occurredAt`),
    };
  });
}

function parseScoreRange(
  raw: { min?: number; max?: number } | undefined,
  name: string,
): { min: number; max: number } {
  if (!raw) throw new Error(`${name}: expectedScore missing`);
  const min = requireNumber(raw.min, `${name}.expectedScore.min`);
  const max = requireNumber(raw.max, `${name}.expectedScore.max`);
  if (min > max) throw new Error(`${name}: expectedScore.min > max`);
  return { min, max };
}

function parseExpectedSignals(
  raw: Partial<Record<string, string[]>> | undefined,
  name: string,
): FixtureExpectation['expectedSignals'] {
  if (!raw) return {};
  const out: FixtureExpectation['expectedSignals'] = {};
  for (const [mode, ids] of Object.entries(raw)) {
    if (!VALID_MODES.includes(mode as SignalMode)) {
      throw new Error(
        `${name}: unknown signal mode "${mode}" — valid: ${VALID_MODES.join(', ')}`,
      );
    }
    if (!Array.isArray(ids)) {
      throw new Error(`${name}: expectedSignals.${mode} must be an array`);
    }
    out[mode as SignalMode] = ids;
  }
  return out;
}

function requireString(v: unknown, key: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${key}: expected non-empty string`);
  }
  return v;
}

function requireNumber(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${key}: expected finite number`);
  }
  return v;
}

export function validateAgainstRubric(
  fixture: Fixture,
  rubricSignalIds: ReadonlySet<string>,
): void {
  const unknown: string[] = [];
  for (const ids of Object.values(fixture.expectedSignals)) {
    for (const id of ids ?? []) {
      if (!rubricSignalIds.has(id)) unknown.push(id);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Fixture ${fixture.name}: unknown signal IDs in expectedSignals: ${unknown.join(', ')}`,
    );
  }
}
