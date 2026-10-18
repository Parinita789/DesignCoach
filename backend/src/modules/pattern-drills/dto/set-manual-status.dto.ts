import { IsIn, IsString } from 'class-validator';
import { MANUAL_STATUSES, ManualStatus } from '../types/pattern-drill.types';

export class SetManualStatusDto {
  @IsString()
  itemId!: string;

  @IsIn(MANUAL_STATUSES)
  status!: ManualStatus;
}
