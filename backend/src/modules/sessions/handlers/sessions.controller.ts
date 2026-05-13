import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionsService } from '../services/sessions.service';
import { EndSessionDto } from '../dto/end-session.dto';
import { PaginationQueryDto, toPrismaPagination } from '../../../common/pagination/pagination';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post(':id/end')
  @ApiOperation({
    summary: 'End a session (completed or abandoned)',
    description:
      'On completed, runs the plan-phase evaluation synchronously and fires deep-dive + per-signal mentor in the background. On abandoned, marks the session and skips evaluation.',
  })
  end(@Param('id') id: string, @Body() dto: EndSessionDto) {
    return this.sessionsService.end(id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a session including its parent question' })
  get(@Param('id') id: string) {
    return this.sessionsService.getWithQuestion(id);
  }

  @Get()
  @ApiOperation({
    summary: 'List sessions, newest first',
    description: `Paginated. Defaults: page=1, limit=50. Max limit=200.`,
  })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  list(@Query() pagination: PaginationQueryDto) {
    return this.sessionsService.list(toPrismaPagination(pagination));
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hard-delete a session and everything tied to it',
    description:
      'Removes the session row synchronously; FK CASCADE wipes related rows in the same transaction (snapshots, hints, build_events, build_ai_interactions, phase_evaluations and their downstream artifacts). On-disk mentor + signal-mentor prompt/response files are cleaned up fire-and-forget after the response.',
  })
  delete(@Param('id') id: string) {
    return this.sessionsService.deleteSession(id);
  }
}
