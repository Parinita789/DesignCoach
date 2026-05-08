import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const ROLES = ['user', 'assistant', 'tool_use', 'tool_result'] as const;

export class BuildAIInteractionDto {
  @IsString()
  @MaxLength(64)
  tool!: string;

  @IsString()
  @MaxLength(128)
  externalSessionId!: string;

  @IsInt()
  @Min(0)
  turnIndex!: number;

  @IsIn(ROLES)
  role!: (typeof ROLES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  text?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  toolName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  toolInputSummary?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  toolResultSummary?: string | null;

  @IsISO8601()
  occurredAt!: string;
}

export class BuildAIInteractionBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BuildAIInteractionDto)
  interactions!: BuildAIInteractionDto[];
}
