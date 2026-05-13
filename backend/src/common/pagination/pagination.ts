import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Shared pagination contract for unbounded list endpoints.
//
// Each list endpoint accepts `?page=N&limit=M`. The helper converts
// those to Prisma's `{ take, skip }` so repositories don't reason
// about page numbers. Defaults are tuned for the current data
// volumes (50/page) with a hard ceiling of 200 so a single
// request can't materialize the whole table.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

export interface PrismaPagination {
  take: number;
  skip: number;
}

export function toPrismaPagination(dto: PaginationQueryDto | undefined): PrismaPagination {
  const limit = dto?.limit ?? DEFAULT_PAGE_SIZE;
  const page = dto?.page ?? 1;
  return {
    take: limit,
    skip: (page - 1) * limit,
  };
}
