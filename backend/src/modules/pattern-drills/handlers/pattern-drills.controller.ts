import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LLM_POST_THROTTLE } from '../../throttling/throttle-presets';
import { PatternDrillsService } from '../services/pattern-drills.service';
import { SubmitDrillSetDto } from '../dto/submit-drill-set.dto';
import { SetManualStatusDto } from '../dto/set-manual-status.dto';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { GUARDRAIL_PRESETS } from '../../guardrails/presets';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';

@ApiTags('pattern-drills')
@Controller('pattern-drills')
export class PatternDrillsController {
  constructor(
    private readonly patternDrills: PatternDrillsService,
    private readonly guardrails: GuardrailsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Get today's classification drill set",
    description:
      'Returns the outstanding unsubmitted set if one exists; otherwise generates a fresh set, ' +
      'picking patterns from your own history (least-practiced first) — no input needed.',
  })
  async generate(@CurrentUser() user: AuthenticatedUser) {
    const { set, isOutstanding } = await this.patternDrills.generateOrGetOutstanding(user.id);
    return { ...set, isOutstanding };
  }

  @Get()
  @ApiOperation({ summary: 'List past drill sets' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.patternDrills.listByUser(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single drill set' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.patternDrills.getById(id, user.id);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a drill set (e.g. one seeded with test/mock data)' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.patternDrills.delete(id, user.id);
    return { ok: true };
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Set a per-item personal review status (pending/in_progress/solved)',
    description:
      'Independent of the LLM-graded verdict — editable any time, including on a submitted set.',
  })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetManualStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patternDrills.setManualStatus(id, user.id, dto.itemId, dto.status);
  }

  @Post(':id/submit')
  @Throttle(LLM_POST_THROTTLE)
  @ApiOperation({ summary: 'Submit answers for a drill set and grade them' })
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitDrillSetDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Guard runs before any answer text reaches the LLM or persistence
    // layer — trims, enforces size, escapes literal </drill_answer>. Guard
    // requires non-empty input, so firstMove (optional) only runs through
    // it when actually provided.
    const sanitizedAnswers = dto.answers.map((answer) => ({
      itemId: answer.itemId,
      pattern: answer.pattern,
      triggerPhrase: this.guardrails.guard(answer.triggerPhrase, GUARDRAIL_PRESETS.drillAnswer)
        .sanitized,
      firstMove: answer.firstMove?.trim()
        ? this.guardrails.guard(answer.firstMove, GUARDRAIL_PRESETS.drillAnswer).sanitized
        : undefined,
    }));
    return this.patternDrills.submit(id, user.id, sanitizedAnswers);
  }
}
