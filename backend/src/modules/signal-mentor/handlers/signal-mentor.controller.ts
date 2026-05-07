import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SignalMentorService } from '../services/signal-mentor.service';
import { GenerateSignalMentorDto } from '../dto/generate-signal-mentor.dto';

@ApiTags('signal-mentor')
@Controller('signal-mentor')
export class SignalMentorController {
  constructor(private readonly signalMentorService: SignalMentorService) {}

  @Get(':evaluationId')
  @ApiOperation({
    summary: 'Get per-signal coaching for an evaluation',
    description:
      'Returns a `{signal_id → annotation}` map populated only for "gap" signals (missed-good and fired-bad). Empty `annotations` when the plan was perfect. 404 until the background generation lands; the frontend polls every 5s.',
  })
  get(@Param('evaluationId') evaluationId: string) {
    return this.signalMentorService.getByEvaluation(evaluationId);
  }

  @Post(':evaluationId')
  @ApiOperation({
    summary: 'Generate or regenerate per-signal coaching',
    description:
      'Computes the gap set, runs the batched LLM call (tool-use schema with required gap-id keys when supported, JSON fallback otherwise), drops hallucinated ids, upserts by phaseEvaluationId. Optional model override.',
  })
  generate(
    @Param('evaluationId') evaluationId: string,
    @Body() body?: GenerateSignalMentorDto,
  ) {
    return this.signalMentorService.generate(evaluationId, body?.model);
  }
}
