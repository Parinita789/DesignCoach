import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PatternDrillSetsRepository } from '../repositories/pattern-drill-sets.repository';
import { PatternDrillBankService } from './pattern-drill-bank.service';
import { LlmService } from '../../llm/services/llm.service';
import { ChatRole } from '../../llm/constants';
import { AGENTS_CONFIG } from '../../../config/llm-tunables.config';
import { buildDrillGradingSystemPrompt } from '../prompts/drill-grading-system-prompt';
import {
  buildSubmitDrillGradesTool,
  SUBMIT_DRILL_GRADES_TOOL_NAME,
} from '../prompts/submit-drill-grades-tool-schema';
import { USER_CONTENT_TAGS, wrapUserContent } from '../../../common/prompts/wrap-user-content';
import {
  BankItem,
  Difficulty,
  DrillAnswer,
  DrillItemGrade,
  ManualStatus,
  PatternId,
  PersistedDrillItem,
} from '../types/pattern-drill.types';

// Daily quota. Pattern selection is entirely history-driven now (see
// selectItemsByHistory) — there's no manual "patterns covered" input to
// tune around; this is just how many questions land in each set.
const SET_SIZE = 5;

@Injectable()
export class PatternDrillsService {
  constructor(
    private readonly repo: PatternDrillSetsRepository,
    private readonly bank: PatternDrillBankService,
    private readonly llm: LlmService,
  ) {}

  async generateOrGetOutstanding(userId: string) {
    const outstanding = await this.repo.findOutstanding(userId);
    if (outstanding) {
      return { set: outstanding, isOutstanding: true };
    }

    const attemptCounts = await this.patternAttemptCounts(userId);
    const chosen = selectItemsByHistory(this.bank.all(), attemptCounts, SET_SIZE);
    const items: PersistedDrillItem[] = chosen.map((item) => ({
      itemId: item.id,
      statement: item.statement,
    }));
    // Repurposed: this column now records which patterns THIS set actually
    // targeted (the picker's output), not a user-supplied input — kept so
    // the progress view can show "today's focus" without re-deriving it
    // from the (still answer-key-bearing) items.
    const targetedPatterns = [...new Set(chosen.map((item) => item.pattern))];
    const created = await this.repo.create({
      userId,
      coveredPatterns: targetedPatterns as unknown as Prisma.InputJsonValue,
      items: items as unknown as Prisma.InputJsonValue,
    });
    return { set: created, isOutstanding: false };
  }

  private async patternAttemptCounts(userId: string): Promise<Map<PatternId, number>> {
    const rows = await this.repo.findGradedResultsByUser(userId);
    const counts = new Map<PatternId, number>();
    for (const row of rows) {
      const grades = (row.gradedResult as unknown as DrillItemGrade[] | null) ?? [];
      for (const grade of grades) {
        counts.set(grade.pattern, (counts.get(grade.pattern) ?? 0) + 1);
      }
    }
    return counts;
  }

  async getById(id: string, userId: string) {
    const set = await this.repo.findByIdForUser(id, userId);
    if (!set) {
      throw new NotFoundException(`Pattern drill set ${id} not found`);
    }
    return set;
  }

  listByUser(userId: string) {
    return this.repo.listByUser(userId);
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.getById(id, userId); // 404s if missing or not owned by this user
    await this.repo.delete(id);
  }

  // Personal review status, independent of grading — editable any time,
  // including on a submitted/locked set, since it's not part of the drill's
  // verdict.
  async setManualStatus(id: string, userId: string, itemId: string, status: ManualStatus) {
    const set = await this.getById(id, userId);
    const items = set.items as unknown as PersistedDrillItem[];
    if (!items.some((item) => item.itemId === itemId)) {
      throw new BadRequestException(`Item ${itemId} is not part of set ${id}`);
    }
    const current = (set.manualStatus as unknown as Record<string, ManualStatus> | null) ?? {};
    const updated = { ...current, [itemId]: status };
    return this.repo.updateManualStatus(id, updated as unknown as Prisma.InputJsonValue);
  }

  async submit(id: string, userId: string, answers: DrillAnswer[]) {
    const set = await this.getById(id, userId);
    if (set.submittedAt) {
      throw new BadRequestException(`Pattern drill set ${id} was already submitted`);
    }

    const persistedItems = set.items as unknown as PersistedDrillItem[];
    const persistedIds = new Set(persistedItems.map((item) => item.itemId));
    const bankById = new Map(this.bank.all().map((item) => [item.id, item]));

    const itemIds = answers.map((answer) => answer.itemId);
    const promptSections = answers.map((answer) => {
      if (!persistedIds.has(answer.itemId)) {
        throw new BadRequestException(
          `Answer references item ${answer.itemId} which is not part of this set`,
        );
      }
      const canonical = bankById.get(answer.itemId);
      if (!canonical) {
        throw new BadRequestException(`Unknown bank item ${answer.itemId}`);
      }
      return buildItemPromptSection(answer, canonical);
    });

    const useTools = this.llm.supportsToolUse();
    const tool = useTools ? buildSubmitDrillGradesTool(itemIds) : null;
    const response = await this.llm.call(
      [{ role: ChatRole.User, content: promptSections.join('\n\n') }],
      {
        system: buildDrillGradingSystemPrompt(useTools, itemIds),
        ...(tool
          ? { tools: [tool], toolChoice: { type: 'tool', name: SUBMIT_DRILL_GRADES_TOOL_NAME } }
          : {}),
        maxTokens: AGENTS_CONFIG.patternDrillGrader.maxTokens,
        model: AGENTS_CONFIG.patternDrillGrader.defaultModel,
        userId,
        route: 'pattern-drills.submit',
      },
    );

    type RawGrade = { patternCorrect: boolean; triggerPhraseAcceptable: boolean; explanation: string };
    let rawGrades: Record<string, RawGrade>;
    if (response.toolUse) {
      rawGrades = response.toolUse.input as Record<string, RawGrade>;
    } else {
      const parsed = extractJsonObject(response.text);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Pattern-drill grading call returned no usable tool output or JSON');
      }
      rawGrades = parsed as Record<string, RawGrade>;
    }

    const gradedResult: DrillItemGrade[] = itemIds.map((itemId) => {
      const raw = rawGrades[itemId];
      const patternCorrect = raw?.patternCorrect ?? false;
      const triggerPhraseAcceptable = raw?.triggerPhraseAcceptable ?? false;
      // Guaranteed present: submit() already threw above if any itemId in
      // this set were missing from bankById.
      const pattern = bankById.get(itemId)!.pattern;
      return {
        itemId,
        pattern,
        patternCorrect,
        triggerPhraseAcceptable,
        correct: patternCorrect && triggerPhraseAcceptable,
        explanation: raw?.explanation ?? '',
      };
    });

    return this.repo.markSubmitted(id, {
      submission: answers as unknown as Prisma.InputJsonValue,
      gradedResult: gradedResult as unknown as Prisma.InputJsonValue,
    });
  }
}

function buildItemPromptSection(answer: DrillAnswer, canonical: BankItem): string {
  const firstMove = answer.firstMove?.trim()
    ? wrapUserContent(answer.firstMove, USER_CONTENT_TAGS.drillAnswer)
    : '(not provided — do not penalize this)';
  return `<item id="${answer.itemId}">
Canonical pattern: ${canonical.pattern}
Canonical trigger phrase: ${canonical.triggerPhrase}
Canonical first move: ${canonical.firstMove}
Candidate's claimed pattern: ${answer.pattern}
Candidate's trigger phrase: ${wrapUserContent(answer.triggerPhrase, USER_CONTENT_TAGS.drillAnswer)}
Candidate's first move: ${firstMove}
</item>`;
}

// Exported for unit tests. Ranks the patterns that actually have bank
// content by ascending attempt count (never-attempted patterns first,
// ties broken randomly), then fills the set from the least-practiced
// patterns first. Whenever a pick has a boundary-pair partner with its
// own content, the next slot is pulled from that partner instead of
// simply the next-least-practiced pattern — surfacing the user's actual
// confusion points (e.g. two_pointers vs modified_binary_search) rather
// than just rotating through untouched patterns one at a time.
export function selectItemsByHistory(
  bank: BankItem[],
  attemptCounts: Map<PatternId, number>,
  setSize: number = SET_SIZE,
  random: () => number = Math.random,
): BankItem[] {
  const availablePatterns = new Set(bank.map((item) => item.pattern));
  const rankedPatterns = shuffle([...availablePatterns], random).sort(
    (a, b) => (attemptCounts.get(a) ?? 0) - (attemptCounts.get(b) ?? 0),
  );

  const usedItemIds = new Set<string>();
  const chosen: BankItem[] = [];

  const takeFrom = (pattern: PatternId): BankItem | null => {
    const candidates = bank.filter(
      (item) => item.pattern === pattern && !usedItemIds.has(item.id),
    );
    if (candidates.length === 0) return null;
    const item = weightedPickByDifficulty(candidates, random);
    usedItemIds.add(item.id);
    chosen.push(item);
    return item;
  };

  for (const pattern of rankedPatterns) {
    if (chosen.length >= setSize) break;
    const picked = takeFrom(pattern);
    if (!picked || chosen.length >= setSize || !picked.boundaryPairWith) continue;

    const partner = shuffle([...picked.boundaryPairWith], random).find((p) =>
      availablePatterns.has(p),
    );
    if (partner) takeFrom(partner);
  }

  return shuffle(chosen, random);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Hard problems get picked ~4x as often as easy ones, medium ~2x — biased
// toward "actually tests understanding" without making easy/medium items
// unreachable (a mix still matters early on, and this keeps the picker from
// being deterministic). Missing difficulty defaults to medium.
const DIFFICULTY_WEIGHT: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 4 };

// Exported for unit tests.
export function weightedPickByDifficulty(candidates: BankItem[], random: () => number): BankItem {
  const weights = candidates.map((item) => DIFFICULTY_WEIGHT[item.difficulty ?? 'medium']);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// Minimal JSON-text extractor for the non-tool-use fallback (claude_cli,
// ollama). Mirrors PlanAgent's private extractJsonObject — duplicated
// rather than imported so this module stays independent of evaluations.
function extractJsonObject(rawText: string): unknown {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    if (start === -1) {
      throw new Error('Pattern-drill grading call did not return any JSON object');
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(stripped.slice(start, i + 1));
        }
      }
    }
    throw new Error('Pattern-drill grading call returned an unbalanced JSON object');
  }
}
