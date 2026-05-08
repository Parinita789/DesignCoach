import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BuildSessionsService } from '../services/build-sessions.service';

@ApiTags('build-sessions')
@Controller('sessions')
export class StartBuildController {
  constructor(private readonly buildSessions: BuildSessionsService) {}

  @Post(':id/start-build')
  @ApiOperation({
    summary: 'Mint a CLI bearer token for the build phase',
    description:
      "Marks build_started_at on the session, generates a one-time token of shape `<sessionId>.<secret>` (bcrypt hash stored on the row), and returns it to the web app. The candidate runs `mentor watch <token>` locally; the CLI presents the token on every flush. Calling this endpoint again rotates the token (old hash overwritten). Returns 400 if the path id is not a UUID, 404 if the session does not exist, 409 if the session is abandoned or the build phase already finished.",
  })
  startBuild(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.buildSessions.startBuildPhase(id);
  }

  @Get(':id/build-events')
  @ApiOperation({
    summary: 'Build-phase status + per-file event aggregate',
    description:
      'Returns the build phase timestamps + total event count + a per-file aggregate summary. Used by the results page to poll for "waiting / in progress / complete" status and render the build-timeline widget.',
  })
  buildEventsSummary(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.buildSessions.eventsSummary(id);
  }
}
