import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DashboardService } from '../services/dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('trend')
  @ApiOperation({ summary: 'Score-over-time trend across sessions' })
  @ApiQuery({ name: 'rubricVersion', required: false })
  trend(@Query('rubricVersion') rubricVersion?: string) {
    return this.dashboardService.scoreTrend(rubricVersion);
  }

  @Get('heatmap')
  @ApiOperation({ summary: 'Signal-by-signal hit/miss heatmap across sessions' })
  @ApiQuery({ name: 'rubricVersion', required: false })
  heatmap(@Query('rubricVersion') rubricVersion?: string) {
    return this.dashboardService.signalHeatmap(rubricVersion);
  }

  @Get('weaknesses')
  @ApiOperation({ summary: 'Signals the candidate keeps missing / firing badly' })
  @ApiQuery({ name: 'rubricVersion', required: false })
  weaknesses(@Query('rubricVersion') rubricVersion?: string) {
    return this.dashboardService.recurringWeaknesses(rubricVersion);
  }
}
