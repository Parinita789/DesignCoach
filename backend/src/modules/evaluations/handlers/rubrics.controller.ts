import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RubricLoaderService } from '../services/rubric-loader.service';
import { Phase } from '../../phase-tagger/types/phase.types';
import { Mode, Seniority } from '../types/rubric.types';

@ApiTags('rubrics')
@Controller('rubrics')
export class RubricsController {
  constructor(private readonly rubricLoader: RubricLoaderService) {}

  @Get(':version/:phase')
  @ApiOperation({
    summary: 'Load a rubric (resolved + seniority-applied)',
    description:
      'Reads the YAML for `version`/`phase`, merges shared + variant for v2.0, and applies the per-signal `weight_by_seniority` map so callers see a single resolved `weight`. Used by the frontend to render the breakdown.',
  })
  @ApiQuery({ name: 'mode', enum: ['build', 'design'], required: false })
  @ApiQuery({ name: 'seniority', enum: ['junior', 'mid', 'senior', 'staff'], required: false })
  get(
    @Param('version') version: string,
    @Param('phase') phase: Phase,
    @Query('mode') mode?: Mode,
    @Query('seniority') seniority?: Seniority,
  ) {
    return this.rubricLoader.load(version, phase, mode, seniority);
  }
}
