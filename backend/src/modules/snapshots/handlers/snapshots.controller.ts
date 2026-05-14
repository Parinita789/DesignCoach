import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SnapshotsService } from '../services/snapshots.service';
import { CaptureSnapshotDto } from '../dto/capture-snapshot.dto';
import { PaginationQueryDto, toPrismaPagination } from '../../../common/pagination/pagination';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { GUARDRAIL_PRESETS } from '../../guardrails/presets';

@ApiTags('snapshots')
@Controller('sessions/:sessionId/snapshots')
export class SnapshotsController {
  constructor(
    private readonly snapshotsService: SnapshotsService,
    private readonly guardrails: GuardrailsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Capture a snapshot of the candidate\'s plan.md',
    description:
      'Inserts a new snapshot row. Called on autosave, manual save, end-of-session flush, and beforeunload (sendBeacon).',
  })
  capture(@Param('sessionId', ParseUUIDPipe) sessionId: string, @Body() dto: CaptureSnapshotDto) {
    // Only guard when planMd is actually supplied. Null/undefined
    // (no plan content this snapshot) flows through unchanged so
    // empty-state snapshots from autosave still persist. Internal
    // service-to-service calls (questions.startAttempt seeding an
    // inherited plan) bypass this controller entirely.
    const planMd = dto.artifacts?.planMd;
    if (planMd == null) {
      return this.snapshotsService.capture(sessionId, dto);
    }
    const { sanitized } = this.guardrails.guard(planMd, GUARDRAIL_PRESETS.plan);
    return this.snapshotsService.capture(sessionId, {
      ...dto,
      artifacts: { ...dto.artifacts, planMd: sanitized },
    });
  }

  @Get('latest')
  @ApiOperation({
    summary: 'Get the most recent snapshot for a session',
    description: 'Used by the active session page to seed Monaco on mount and by retry-inheritance to copy plan.md to a new session.',
  })
  latest(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.snapshotsService.latest(sessionId);
  }

  @Get()
  @ApiOperation({
    summary: 'List snapshots for a session, newest first',
    description: `Paginated. Defaults: page=1, limit=50. Max limit=200.`,
  })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  list(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.snapshotsService.list(sessionId, toPrismaPagination(pagination));
  }
}
