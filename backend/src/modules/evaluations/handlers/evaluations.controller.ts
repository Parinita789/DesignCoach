import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EvaluationsService } from '../services/evaluations.service';
import { RunEvaluationDto } from '../dto/run-evaluation.dto';

@ApiTags('evaluations')
@Controller()
export class EvaluationsController {
  constructor(private readonly evaluationsService: EvaluationsService) {}

  @Post('sessions/:sessionId/evaluate')
  @ApiOperation({
    summary: 'Re-run the plan-phase evaluation for a session',
    description:
      'Loads the rubric, evaluates plan.md via the LLM with tool-use forcing, validates evidence, computes a deterministic score, persists a new evaluation row + audit, and fires deep-dive + per-signal mentor in the background. Optional model override.',
  })
  runForSession(
    @Param('sessionId') sessionId: string,
    @Body() body?: RunEvaluationDto,
  ) {
    return this.evaluationsService.runForSession(sessionId, body?.model);
  }

  @Get('sessions/:sessionId/evaluations')
  @ApiOperation({
    summary: 'List every evaluation for a session, newest first',
    description: 'Each Re-evaluate inserts a new row; history is preserved.',
  })
  listForSession(@Param('sessionId') sessionId: string) {
    return this.evaluationsService.getBySession(sessionId);
  }

  @Get('evaluations/:id/status')
  @ApiOperation({ summary: 'Evaluation status (always complete in the synchronous flow)' })
  status() {
    return { state: 'complete' as const };
  }

  @Get('evaluations/:id')
  @ApiOperation({ summary: 'Get a single evaluation by id' })
  get(@Param('id') id: string) {
    return this.evaluationsService.getById(id);
  }

  @Get('evaluations/:id/audit')
  @ApiOperation({
    summary: 'Get the LLM audit trail for an evaluation',
    description:
      'Returns the rendered prompt, raw LLM response, model used, token counts, cache hit/miss tokens, and latency. The bytes the parser ate, not summary metadata.',
  })
  getAudit(@Param('id') id: string) {
    return this.evaluationsService.getAudit(id);
  }
}
