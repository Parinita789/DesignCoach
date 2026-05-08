import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { RubricLoaderService } from '../services/rubric-loader.service';
import { Phase } from '../../phase-tagger/types/phase.types';
import {
  QUESTION_KINDS,
  QuestionKind,
  SENIORITIES,
  Seniority,
} from '../types/rubric.types';

class RubricQueryDto {
  @IsOptional()
  @IsIn(QUESTION_KINDS as readonly string[])
  kind?: QuestionKind;

  @IsOptional()
  @IsIn(SENIORITIES as readonly string[])
  seniority?: Seniority;
}

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
  @ApiQuery({ name: 'kind', enum: QUESTION_KINDS as readonly string[], required: false })
  @ApiQuery({ name: 'seniority', enum: SENIORITIES as readonly string[], required: false })
  get(
    @Param('version') version: string,
    @Param('phase') phase: Phase,
    @Query() query: RubricQueryDto,
  ) {
    return this.rubricLoader.load(version, phase, query.kind, query.seniority);
  }
}
