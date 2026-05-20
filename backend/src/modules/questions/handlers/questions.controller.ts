import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LLM_POST_THROTTLE } from '../../throttling/throttle-presets';
import { QuestionsService } from '../services/questions.service';
import { CreateQuestionDto, StartAttemptDto } from '../dto/create-question.dto';
import { PaginationQueryDto, toPrismaPagination } from '../../../common/pagination/pagination';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { GUARDRAIL_PRESETS } from '../../guardrails/presets';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';

@ApiTags('questions')
@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly questionsService: QuestionsService,
    private readonly guardrails: GuardrailsService,
  ) {}

  @Post()
  @Throttle(LLM_POST_THROTTLE)
  @ApiOperation({
    summary: 'Create a question + first attempt',
    description:
      'Persists a new question prompt and immediately starts the candidate\'s first session against it. Returns both rows.',
  })
  create(@Body() dto: CreateQuestionDto, @CurrentUser() user: AuthenticatedUser) {
    // Guard the prompt before persistence + LLM use. Sanitized
    // form replaces the raw prompt; service sees the cleaned
    // value. Throws GuardrailRejectedError → HTTP 400.
    const { sanitized } = this.guardrails.guard(dto.prompt, GUARDRAIL_PRESETS.question);
    return this.questionsService.create({ ...dto, prompt: sanitized }, user.id);
  }

  @Get()
  @ApiOperation({
    summary: 'List questions with sessions + scores, newest first',
    description: `Paginated. Defaults: page=1, limit=50. Max limit=200. Filtered to the current user.`,
  })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  list(@Query() pagination: PaginationQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.questionsService.list(user.id, toPrismaPagination(pagination));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one question by id (includes its sessions)' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.questionsService.get(id, user.id);
  }

  @Post(':id/attempts')
  @ApiOperation({
    summary: 'Start a new attempt of an existing question',
    description:
      'Inherits the most recent plan.md across prior sessions for this question. Optional seniority override; otherwise inherits the most recent prior session\'s seniority.',
  })
  startAttempt(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: StartAttemptDto,
  ) {
    return this.questionsService.startAttempt(id, user.id, body?.seniority);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hard-delete a question and every attempt of it',
    description:
      'Removes the question row and all its sessions in a single transaction. Each session cascades through snapshots, hints, build events, captured AI turns, plan + build evaluations and their downstream mentor / signal-mentor artifacts. On-disk per-session prompt+response files are cleaned up fire-and-forget. Returns { ok: true, deletedSessions: N }.',
  })
  delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.questionsService.deleteQuestion(id, user.id);
  }
}
