import { UsersRepository } from './users.repository';
import type { PrismaService } from '../../../database/prisma.service';

function makeRepo() {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  } as unknown as PrismaService;
  return { repo: new UsersRepository(prisma), prisma };
}

describe('UsersRepository.findByEmail', () => {
  it('queries by the email predicate (caller is expected to pre-normalize)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u', email: 'a@b.com' });
    await repo.findByEmail('a@b.com');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
  });

  it('returns null when no row matches', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(repo.findByEmail('nobody@x.com')).resolves.toBeNull();
  });

  it('does NOT lowercase / trim — service layer is responsible (asymmetric storage would mask a bug)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await repo.findByEmail('  Mixed@Case.com  ');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: '  Mixed@Case.com  ' },
    });
  });
});

describe('UsersRepository.findById', () => {
  it('queries by primary key', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'uid-1' });
    await repo.findById('uid-1');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'uid-1' } });
  });
});

describe('UsersRepository.create', () => {
  it('passes only email + passwordHash to Prisma (no extra fields slip in)', async () => {
    const { repo, prisma } = makeRepo();
    (prisma.user.create as jest.Mock).mockResolvedValue({
      id: 'new',
      email: 'a@b.com',
      passwordHash: '$2b$12$xxx',
      createdAt: new Date(),
    });
    await repo.create({ email: 'a@b.com', passwordHash: '$2b$12$xxx' });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'a@b.com', passwordHash: '$2b$12$xxx' },
    });
  });
});
