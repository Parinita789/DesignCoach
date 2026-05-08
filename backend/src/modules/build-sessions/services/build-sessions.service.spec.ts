import { ConflictException, NotFoundException } from '@nestjs/common';
import { BuildSessionsService } from './build-sessions.service';

const SID = '11111111-2222-3333-4444-555555555555';

function makePrisma() {
  return {
    session: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeAi(overrides: Partial<{ insertBatch: jest.Mock; countsForSession: jest.Mock }> = {}) {
  return {
    insertBatch: overrides.insertBatch ?? jest.fn(),
    countsForSession: overrides.countsForSession ?? jest.fn().mockResolvedValue({ total: 0, distinctSessions: 0 }),
  };
}

function makeEvents(overrides: Partial<{ insertBatch: jest.Mock; summaryForSession: jest.Mock }> = {}) {
  return {
    insertBatch: overrides.insertBatch ?? jest.fn(),
    summaryForSession: overrides.summaryForSession ?? jest.fn().mockResolvedValue([]),
  };
}

function makeOrchestrator() {
  return { run: jest.fn().mockResolvedValue([]) };
}

function makeEvalsRepo(overrides: Partial<{ findBySession: jest.Mock }> = {}) {
  return {
    findBySession: overrides.findBySession ?? jest.fn().mockResolvedValue([]),
  };
}

describe('BuildSessionsService.startBuildPhase', () => {
  it('throws NotFoundException when the session does not exist', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue(null);
    const tokens = { mintForSession: jest.fn() };
    const events = makeEvents();
    const ai = makeAi();
    const svc = new BuildSessionsService(prisma as never, tokens as never, events as never, ai as never, makeOrchestrator() as never, makeEvalsRepo() as never);
    await expect(svc.startBuildPhase(SID)).rejects.toBeInstanceOf(NotFoundException);
    expect(tokens.mintForSession).not.toHaveBeenCalled();
  });

  it('throws ConflictException on an abandoned session', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      id: SID,
      status: 'abandoned',
      buildEndedAt: null,
    });
    const tokens = { mintForSession: jest.fn() };
    const svc = new BuildSessionsService(
      prisma as never,
      tokens as never,
      makeEvents() as never,
      makeAi() as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    await expect(svc.startBuildPhase(SID)).rejects.toBeInstanceOf(ConflictException);
    expect(tokens.mintForSession).not.toHaveBeenCalled();
  });

  it('throws ConflictException when the build phase already finished', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      id: SID,
      status: 'completed',
      buildEndedAt: new Date(),
    });
    const tokens = { mintForSession: jest.fn() };
    const svc = new BuildSessionsService(
      prisma as never,
      tokens as never,
      makeEvents() as never,
      makeAi() as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    await expect(svc.startBuildPhase(SID)).rejects.toBeInstanceOf(ConflictException);
    expect(tokens.mintForSession).not.toHaveBeenCalled();
  });

  it('mints a token on a session with no prior build', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      id: SID,
      status: 'completed',
      buildEndedAt: null,
    });
    const minted = {
      token: `${SID}.secret`,
      sessionId: SID,
      expiresInMinutes: 60,
      buildStartedAt: new Date(),
    };
    const tokens = { mintForSession: jest.fn().mockResolvedValue(minted) };
    const svc = new BuildSessionsService(
      prisma as never,
      tokens as never,
      makeEvents() as never,
      makeAi() as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    await expect(svc.startBuildPhase(SID)).resolves.toBe(minted);
    expect(tokens.mintForSession).toHaveBeenCalledWith(SID);
  });
});

describe('BuildSessionsService.finishBuildPhase', () => {
  it('throws NotFoundException when the session does not exist', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue(null);
    const svc = new BuildSessionsService(
      prisma as never,
      {} as never,
      makeEvents() as never,
      makeAi() as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    await expect(svc.finishBuildPhase(SID)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('sets buildEndedAt, dispatches the orchestrator, and returns the count on first call', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      buildEndedAt: null,
      buildEventCount: 7,
    });
    prisma.session.update.mockResolvedValue({ buildEventCount: 7 });
    const orchestrator = makeOrchestrator();
    const svc = new BuildSessionsService(
      prisma as never,
      {} as never,
      makeEvents() as never,
      makeAi() as never,
      orchestrator as never,
      makeEvalsRepo() as never,
    );
    const out = await svc.finishBuildPhase(SID);
    expect(out).toEqual({ ok: true, eventCount: 7 });
    expect(prisma.session.update).toHaveBeenCalledTimes(1);
    const call = prisma.session.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: SID });
    expect(call.data.buildEndedAt).toBeInstanceOf(Date);
    expect(orchestrator.run).toHaveBeenCalledWith(SID, ['build']);
  });

  it('does NOT mutate buildEndedAt on a second call when a build eval exists', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      buildEndedAt: new Date('2026-05-07T00:00:00Z'),
      buildEventCount: 7,
    });
    const evalsRepo = makeEvalsRepo({
      findBySession: jest.fn().mockResolvedValue([{ phase: 'build' }]),
    });
    const orchestrator = makeOrchestrator();
    const svc = new BuildSessionsService(
      prisma as never,
      {} as never,
      makeEvents() as never,
      makeAi() as never,
      orchestrator as never,
      evalsRepo as never,
    );
    const out = await svc.finishBuildPhase(SID);
    expect(out).toEqual({ ok: true, eventCount: 7 });
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(orchestrator.run).not.toHaveBeenCalled();
  });

  it('re-dispatches the orchestrator when buildEndedAt is set but no build eval exists (prior crash recovery)', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      buildEndedAt: new Date('2026-05-07T00:00:00Z'),
      buildEventCount: 7,
    });
    const evalsRepo = makeEvalsRepo({
      findBySession: jest.fn().mockResolvedValue([{ phase: 'plan' }]),
    });
    const orchestrator = makeOrchestrator();
    const svc = new BuildSessionsService(
      prisma as never,
      {} as never,
      makeEvents() as never,
      makeAi() as never,
      orchestrator as never,
      evalsRepo as never,
    );
    const out = await svc.finishBuildPhase(SID);
    expect(out).toEqual({ ok: true, eventCount: 7 });
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(orchestrator.run).toHaveBeenCalledWith(SID, ['build']);
  });
});

describe('BuildSessionsService.insertEvents', () => {
  it('delegates to BuildEventsRepository.insertBatch', async () => {
    const events = makeEvents({ insertBatch: jest.fn().mockResolvedValue(3) });
    const svc = new BuildSessionsService(
      makePrisma() as never,
      {} as never,
      events as never,
      makeAi() as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    const batch = [
      { filePath: 'a.ts', action: 'created' as const, occurredAt: '2026-05-07T00:00:00.000Z' },
    ];
    const out = await svc.insertEvents(SID, batch);
    expect(out).toBe(3);
    expect(events.insertBatch).toHaveBeenCalledWith(SID, batch);
  });
});

describe('BuildSessionsService.insertAiInteractions', () => {
  it('delegates to BuildAIInteractionsRepository.insertBatch', async () => {
    const ai = makeAi({ insertBatch: jest.fn().mockResolvedValue(2) });
    const svc = new BuildSessionsService(
      makePrisma() as never,
      {} as never,
      makeEvents() as never,
      ai as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    const batch = [
      {
        tool: 'claude-code',
        externalSessionId: 'cc-1',
        turnIndex: 0,
        role: 'user' as const,
        text: 'Implement auth',
        occurredAt: '2026-05-07T00:00:00.000Z',
      },
    ];
    const out = await svc.insertAiInteractions(SID, batch);
    expect(out).toBe(2);
    expect(ai.insertBatch).toHaveBeenCalledWith(SID, batch);
  });
});

describe('BuildSessionsService.eventsSummary', () => {
  it('throws NotFoundException for a missing session', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue(null);
    const svc = new BuildSessionsService(
      prisma as never,
      {} as never,
      makeEvents() as never,
      makeAi() as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    await expect(svc.eventsSummary(SID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('joins session timestamps + per-file aggregate + AI counts', async () => {
    const prisma = makePrisma();
    const startedAt = new Date('2026-05-07T00:00:00Z');
    const endedAt = new Date('2026-05-07T01:00:00Z');
    prisma.session.findUnique.mockResolvedValue({
      buildStartedAt: startedAt,
      buildEndedAt: endedAt,
      buildEventCount: 9,
    });
    const events = makeEvents({
      summaryForSession: jest.fn().mockResolvedValue([
        { filePath: 'a.ts', eventCount: 5, firstAt: null, lastAt: null },
      ]),
    });
    const ai = makeAi({
      countsForSession: jest.fn().mockResolvedValue({ total: 12, distinctSessions: 2 }),
    });
    const svc = new BuildSessionsService(
      prisma as never,
      {} as never,
      events as never,
      ai as never,
      makeOrchestrator() as never,
      makeEvalsRepo() as never,
    );
    const out = await svc.eventsSummary(SID);
    expect(out).toEqual({
      buildStartedAt: startedAt,
      buildEndedAt: endedAt,
      eventCount: 9,
      perFile: [{ filePath: 'a.ts', eventCount: 5, firstAt: null, lastAt: null }],
      aiInteractionCount: 12,
      aiSessionsCount: 2,
    });
  });
});
