import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SnapshotsRepository } from '../repositories/snapshots.repository';
import { CaptureSnapshotDto } from '../dto/capture-snapshot.dto';
import { SnapshotArtifacts } from '../types/snapshot.types';

@Injectable()
export class SnapshotsService {
  constructor(private readonly snapshotsRepository: SnapshotsRepository) {}

  capture(sessionId: string, dto: CaptureSnapshotDto) {
    const artifacts: SnapshotArtifacts = {
      planMd: dto.artifacts?.planMd ?? null,
      codeFiles: {},
      gitLog: null,
      newJsonlEntries: [],
    };
    return this.snapshotsRepository.create({
      sessionId,
      elapsedMinutes: dto.elapsedMinutes,
      inferredPhase: null,
      artifacts: artifacts as unknown as Prisma.InputJsonValue,
    });
  }

  list(sessionId: string, pagination?: { take?: number; skip?: number }) {
    return this.snapshotsRepository.findBySession(sessionId, pagination);
  }

  latest(sessionId: string) {
    return this.snapshotsRepository.findLatest(sessionId);
  }
}
