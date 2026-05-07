import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HintsService } from '../services/hints.service';
import { SendHintDto } from '../dto/send-hint.dto';

@ApiTags('hints')
@Controller('sessions/:sessionId/hints')
export class HintsController {
  constructor(private readonly hintsService: HintsService) {}

  @Post()
  @ApiOperation({
    summary: 'Send a Socratic-coach question during an active session',
    description:
      'The bot replies with a hint, never a full solution. Persists prompt + response on the session\'s ai_interactions log.',
  })
  send(@Param('sessionId') sessionId: string, @Body() dto: SendHintDto) {
    return this.hintsService.send(sessionId, dto.message);
  }

  @Get()
  @ApiOperation({ summary: 'List the hint chat history for a session' })
  list(@Param('sessionId') sessionId: string) {
    return this.hintsService.list(sessionId);
  }
}
