import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { BuildEventBatchDto } from '../dto/build-event.dto';
import { BuildAIInteractionBatchDto } from '../dto/build-ai-interaction.dto';
import { AuthedRequest, BuildSessionGuard, resolvedBuildSessionId } from '../guards/build-session.guard';
import { BuildSessionsService } from '../services/build-sessions.service';
import { CliAuthenticated } from '../../auth/decorators/cli-authenticated.decorator';

// CLI-facing controller. Auth'd via the CLI bearer token issued by
// /start-build and validated by BuildSessionGuard — not by JWT.
// @CliAuthenticated() tells the global AuthGuard to skip JWT
// verification (the route is auth'd, but by a sibling guard). DO NOT
// replace with @Public() — that would imply no auth at all.
@ApiTags('build-sessions')
@ApiBearerAuth('bearer')
@CliAuthenticated()
@SkipThrottle()
@UseGuards(BuildSessionGuard)
@Controller('build')
export class BuildController {
  constructor(private readonly buildSessions: BuildSessionsService) {}

  @Post('events')
  @ApiOperation({
    summary: 'Append a batch of CLI-captured file events',
    description:
      'CLI watcher endpoint. Batched insert with an atomic counter bump on the parent session. The guard pulls the session id from the bearer token, so this route does not take a path parameter.',
  })
  async events(
    @Req() req: AuthedRequest,
    @Body() dto: BuildEventBatchDto,
  ) {
    const sessionId = resolvedBuildSessionId(req);
    const accepted = await this.buildSessions.insertEvents(sessionId, dto.events);
    return { accepted };
  }

  @Post('ai-interactions')
  @ApiOperation({
    summary: 'Append a batch of CLI-captured Claude Code conversation turns',
    description:
      'Per-project AI conversation log batched insert. Truncated at the CLI before shipping. Composite unique constraint on (sessionId, externalSessionId, turnIndex) silently dedupes re-shipped turns when the CLI cursor file is wiped or out of sync.',
  })
  async aiInteractions(
    @Req() req: AuthedRequest,
    @Body() dto: BuildAIInteractionBatchDto,
  ) {
    const sessionId = resolvedBuildSessionId(req);
    const accepted = await this.buildSessions.insertAiInteractions(
      sessionId,
      dto.interactions,
    );
    return { accepted };
  }

  @Post('finish')
  @ApiOperation({
    summary: 'Mark the build phase finished (no more events accepted)',
    description:
      "Sets build_ended_at, freezing the build_events log. Idempotent on re-call. Phase 4's BuildAgent dispatch will hook in here.",
  })
  finish(@Req() req: AuthedRequest) {
    const sessionId = resolvedBuildSessionId(req);
    return this.buildSessions.finishBuildPhase(sessionId);
  }
}
