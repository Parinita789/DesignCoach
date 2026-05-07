import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { QuestionsService } from '../services/questions.service';
import { CreateQuestionDto, StartAttemptDto } from '../dto/create-question.dto';

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
  @ApiOperation({ summary: 'List every question with its sessions + scores' })
  list() {
    return this.questionsService.list();
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
}
