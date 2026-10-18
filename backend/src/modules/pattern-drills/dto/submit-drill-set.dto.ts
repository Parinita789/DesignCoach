import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PATTERN_IDS, PatternId } from '../types/pattern-drill.types';

export class DrillAnswerDto {
  @IsString()
  itemId!: string;

  @IsIn(PATTERN_IDS)
  pattern!: PatternId;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  triggerPhrase!: string;

  // Optional — grading (patternCorrect / triggerPhraseAcceptable) never
  // depends on this field. It's extra context for the grader, not a
  // required part of a correct answer.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  firstMove?: string;
}

export class SubmitDrillSetDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => DrillAnswerDto)
  answers!: DrillAnswerDto[];
}
