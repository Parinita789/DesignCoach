import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionsService } from '../services/sessions.service';
import { EndSessionDto } from '../dto/end-session.dto';

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
  @ApiOperation({ summary: 'List every session, newest first' })
  list() {
    return this.sessionsService.list();
  }
}
