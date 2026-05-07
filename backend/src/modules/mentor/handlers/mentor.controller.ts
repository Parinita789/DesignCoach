import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MentorService } from '../services/mentor.service';
import { GenerateMentorDto } from '../dto/generate-mentor.dto';

@ApiTags('mentor')
@Controller('mentor')
export class MentorController {
  constructor(private readonly mentorService: MentorService) {}

  @Get(':evaluationId')
  @ApiOperation({
    summary: 'Get the deep-dive mentor artifact for an evaluation',
    description:
      'Returns the 6-section Markdown teaching artifact. 404 until the background generation lands; the frontend polls every 5s.',
  })
  get(@Param('evaluationId') evaluationId: string) {
    return this.mentorService.getByEvaluation(evaluationId);
  }

  @Post(':evaluationId')
  @ApiOperation({
    summary: 'Generate or regenerate the deep-dive mentor artifact',
    description:
      'Runs the LLM teaching pass. Upserts by phaseEvaluationId so a second call overwrites. Optional model override.',
  })
  generate(
    @Param('evaluationId') evaluationId: string,
    @Body() body?: GenerateMentorDto,
  ) {
    return this.mentorService.generate(evaluationId, body?.model);
  }
}
