import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SnapshotsService } from '../services/snapshots.service';
import { CaptureSnapshotDto } from '../dto/capture-snapshot.dto';

@ApiTags('snapshots')
@Controller('sessions/:sessionId/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  @Post()
  @ApiOperation({
    summary: 'Capture a snapshot of the candidate\'s plan.md',
    description:
      'Inserts a new snapshot row. Called on autosave, manual save, end-of-session flush, and beforeunload (sendBeacon).',
  })
  capture(@Param('sessionId') sessionId: string, @Body() dto: CaptureSnapshotDto) {
    return this.snapshotsService.capture(sessionId, dto);
  }

  @Get('latest')
  @ApiOperation({
    summary: 'Get the most recent snapshot for a session',
    description: 'Used by the active session page to seed Monaco on mount and by retry-inheritance to copy plan.md to a new session.',
  })
  latest(@Param('sessionId') sessionId: string) {
    return this.snapshotsService.latest(sessionId);
  }

  @Get()
  @ApiOperation({ summary: 'List every snapshot for a session, newest first' })
  list(@Param('sessionId') sessionId: string) {
    return this.snapshotsService.list(sessionId);
  }
}
