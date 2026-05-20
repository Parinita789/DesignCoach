import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LLM_POST_THROTTLE } from '../../throttling/throttle-presets';
import { MentorService } from '../services/mentor.service';
import { GenerateMentorDto } from '../dto/generate-mentor.dto';
import { OwnershipService } from '../../auth/services/ownership.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';

@ApiTags('mentor')
@Controller('mentor')
export class MentorController {
  constructor(
    private readonly mentorService: MentorService,
    private readonly ownership: OwnershipService,
  ) {}

  @Get(':evaluationId')
  @ApiOperation({
    summary: 'Get the deep-dive mentor artifact for an evaluation',
    description:
      'Returns the 6-section Markdown teaching artifact. 404 until the background generation lands; the frontend polls every 5s.',
  })
  async get(
    @Param('evaluationId', ParseUUIDPipe) evaluationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.ownership.assertOwnsEvaluation(evaluationId, user.id);
    return this.mentorService.getByEvaluation(evaluationId);
  }

  @Post(':evaluationId')
  @Throttle(LLM_POST_THROTTLE)
  @ApiOperation({
    summary: 'Generate or regenerate the deep-dive mentor artifact',
    description:
      'Runs the LLM teaching pass. Upserts by phaseEvaluationId so a second call overwrites. Optional model override.',
  })
  async generate(
    @Param('evaluationId', ParseUUIDPipe) evaluationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: GenerateMentorDto,
  ) {
    await this.ownership.assertOwnsEvaluation(evaluationId, user.id);
    return this.mentorService.generate(evaluationId, body?.model);
  }
}
