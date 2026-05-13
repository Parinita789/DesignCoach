import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { QuestionsService } from '../services/questions.service';
import { CreateQuestionDto, StartAttemptDto } from '../dto/create-question.dto';
import { PaginationQueryDto, toPrismaPagination } from '../../../common/pagination/pagination';

@ApiTags('questions')
@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a question + first attempt',
    description:
      'Persists a new question prompt and immediately starts the candidate\'s first session against it. Returns both rows.',
  })
  create(@Body() dto: CreateQuestionDto) {
    return this.questionsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List questions with sessions + scores, newest first',
    description: `Paginated. Defaults: page=1, limit=50. Max limit=200.`,
  })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  list(@Query() pagination: PaginationQueryDto) {
    return this.questionsService.list(toPrismaPagination(pagination));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one question by id (includes its sessions)' })
  get(@Param('id') id: string) {
    return this.questionsService.get(id);
  }

  @Post(':id/attempts')
  @ApiOperation({
    summary: 'Start a new attempt of an existing question',
    description:
      'Inherits the most recent plan.md across prior sessions for this question. Optional seniority override; otherwise inherits the most recent prior session\'s seniority.',
  })
  startAttempt(@Param('id') id: string, @Body() body?: StartAttemptDto) {
    return this.questionsService.startAttempt(id, body?.seniority);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hard-delete a question and every attempt of it',
    description:
      'Removes the question row and all its sessions in a single transaction. Each session cascades through snapshots, hints, build events, captured AI turns, plan + build evaluations and their downstream mentor / signal-mentor artifacts. On-disk per-session prompt+response files are cleaned up fire-and-forget. Returns { ok: true, deletedSessions: N }.',
  })
  delete(@Param('id') id: string) {
    return this.questionsService.deleteQuestion(id);
  }
}
