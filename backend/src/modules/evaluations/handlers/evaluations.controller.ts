import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LLM_POST_THROTTLE } from '../../throttling/throttle-presets';
import { EvaluationsService } from '../services/evaluations.service';
import { RunEvaluationDto } from '../dto/run-evaluation.dto';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { OwnershipService } from '../../auth/services/ownership.service';

@ApiTags('evaluations')
@Controller()
export class EvaluationsController {
  constructor(
    private readonly evaluationsService: EvaluationsService,
    private readonly ownership: OwnershipService,
  ) {}

  @Post('sessions/:sessionId/evaluate')
  @Throttle(LLM_POST_THROTTLE)
  @ApiOperation({
    summary: 'Re-run the plan-phase evaluation for a session',
    description:
      'Loads the rubric, evaluates plan.md via the LLM with tool-use forcing, validates evidence, computes a deterministic score, persists a new evaluation row + audit, and fires deep-dive + per-signal mentor in the background. Optional model override.',
  })
  async runForSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: RunEvaluationDto,
  ) {
    await this.ownership.assertOwnsSession(sessionId, user.id);
    return this.evaluationsService.runForSession(sessionId, body?.model);
  }

  @Get('sessions/:sessionId/evaluations')
  @ApiOperation({
    summary: 'List every evaluation for a session, newest first',
    description: 'Each Re-evaluate inserts a new row; history is preserved.',
  })
  async listForSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.ownership.assertOwnsSession(sessionId, user.id);
    return this.evaluationsService.getBySession(sessionId);
  }

  @Get('evaluations/:id/status')
  @ApiOperation({ summary: 'Evaluation status (always complete in the synchronous flow)' })
  async status(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.ownership.assertOwnsEvaluation(id, user.id);
    return { state: 'complete' as const };
  }

  @Get('evaluations/:id')
  @ApiOperation({ summary: 'Get a single evaluation by id' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.ownership.assertOwnsEvaluation(id, user.id);
    return this.evaluationsService.getById(id);
  }

  @Get('evaluations/:id/audit')
  @ApiOperation({
    summary: 'Get the LLM audit trail for an evaluation',
    description:
      'Returns the rendered prompt, raw LLM response, model used, token counts, cache hit/miss tokens, and latency. The bytes the parser ate, not summary metadata.',
  })
  async getAudit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.ownership.assertOwnsEvaluation(id, user.id);
    return this.evaluationsService.getAudit(id);
  }
}
