import { SnapshotsService } from './snapshots.service';

describe('SnapshotsService', () => {
  let service: SnapshotsService;
  const repo = {
    create: jest.fn(),
    findBySession: jest.fn(),
    findLatest: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SnapshotsService(repo as never);
  });

  describe('capture', () => {
    it('builds a full SnapshotArtifacts object with planMd from the dto', async () => {
      repo.create.mockResolvedValue({ id: 'snap-1' });

      await service.capture('sid-1', {
        elapsedMinutes: 3,
        artifacts: { planMd: '# Plan' },
      });

      expect(repo.create).toHaveBeenCalledWith({
        sessionId: 'sid-1',
        elapsedMinutes: 3,
        inferredPhase: null,
        artifacts: {
          planMd: '# Plan',
          codeFiles: {},
          gitLog: null,
          newJsonlEntries: [],
        },
      });
    });

    it('defaults planMd to null when omitted', async () => {
      repo.create.mockResolvedValue({});

      await service.capture('sid-1', { elapsedMinutes: 0 });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          artifacts: expect.objectContaining({ planMd: null }),
        }),
      );
    });
  });

  describe('list', () => {
    it('delegates to repo.findBySession', async () => {
      repo.findBySession.mockResolvedValue([{ id: 'a' }]);
      expect(await service.list('sid-1')).toEqual([{ id: 'a' }]);
      expect(repo.findBySession).toHaveBeenCalledWith('sid-1', undefined);
    });
  });

  describe('latest', () => {
    it('delegates to repo.findLatest', async () => {
      repo.findLatest.mockResolvedValue({ id: 'latest' });
      expect(await service.latest('sid-1')).toEqual({ id: 'latest' });
      expect(repo.findLatest).toHaveBeenCalledWith('sid-1');
    });
  });
});
