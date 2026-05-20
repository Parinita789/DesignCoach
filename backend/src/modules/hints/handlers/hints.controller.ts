import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LLM_POST_THROTTLE } from '../../throttling/throttle-presets';
import { HintsService } from '../services/hints.service';
import { SendHintDto } from '../dto/send-hint.dto';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { GUARDRAIL_PRESETS } from '../../guardrails/presets';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';

@ApiTags('hints')
@Controller('sessions/:sessionId/hints')
export class HintsController {
  constructor(
    private readonly hintsService: HintsService,
    private readonly guardrails: GuardrailsService,
  ) {}

  @Post()
  @Throttle(LLM_POST_THROTTLE)
  @ApiOperation({
    summary: 'Send a Socratic-coach question during an active session',
    description:
      'The bot replies with a hint, never a full solution. Persists prompt + response on the session\'s ai_interactions log.',
  })
  send(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: SendHintDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Guard runs before the service touches the message — trims,
    // enforces size, and escapes literal </hint_exchange> before
    // anything reaches the LLM or persistence layer. Throws
    // GuardrailRejectedError → HTTP 400 via AllExceptionsFilter.
    const { sanitized } = this.guardrails.guard(dto.message, GUARDRAIL_PRESETS.hint);
    return this.hintsService.send(sessionId, sanitized, user.id);
  }

  @Get()
  @ApiOperation({ summary: 'List the hint chat history for a session' })
  list(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hintsService.list(sessionId, user.id);
  }
}
