import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LLM_POST_THROTTLE } from '../../throttling/throttle-presets';
import { SignalMentorService } from '../services/signal-mentor.service';
import { GenerateSignalMentorDto } from '../dto/generate-signal-mentor.dto';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { OwnershipService } from '../../auth/services/ownership.service';

@ApiTags('signal-mentor')
@Controller('signal-mentor')
export class SignalMentorController {
  constructor(
    private readonly signalMentorService: SignalMentorService,
    private readonly ownership: OwnershipService,
  ) {}

  @Get(':evaluationId')
  @ApiOperation({
    summary: 'Get per-signal coaching for an evaluation',
    description:
      'Returns a `{signal_id → annotation}` map populated only for "gap" signals (missed-good and fired-bad). Empty `annotations` when the plan was perfect. 404 until the background generation lands; the frontend polls every 5s.',
  })
  async get(
    @Param('evaluationId', ParseUUIDPipe) evaluationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.ownership.assertOwnsEvaluation(evaluationId, user.id);
    return this.signalMentorService.getByEvaluation(evaluationId);
  }

  @Post(':evaluationId')
  @Throttle(LLM_POST_THROTTLE)
  @ApiOperation({
    summary: 'Generate or regenerate per-signal coaching',
    description:
      'Computes the gap set, runs the batched LLM call (tool-use schema with required gap-id keys when supported, JSON fallback otherwise), drops hallucinated ids, upserts by phaseEvaluationId. Optional model override.',
  })
  async generate(
    @Param('evaluationId', ParseUUIDPipe) evaluationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: GenerateSignalMentorDto,
  ) {
    await this.ownership.assertOwnsEvaluation(evaluationId, user.id);
    return this.signalMentorService.generate(evaluationId, body?.model);
  }
}
