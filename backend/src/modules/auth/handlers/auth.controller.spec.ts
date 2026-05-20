import { NotFoundException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { AuthService } from '../services/auth.service';
import type { UsersRepository } from '../repositories/users.repository';
import type { AuthenticatedUser } from '../types/auth.types';

function makeController(opts: {
  signup?: jest.Mock;
  login?: jest.Mock;
  findById?: jest.Mock;
} = {}) {
  const auth = {
    signup: opts.signup ?? jest.fn().mockResolvedValue({ user: {}, token: 't' }),
    login: opts.login ?? jest.fn().mockResolvedValue({ user: {}, token: 't' }),
  } as unknown as AuthService;
  const users = {
    findById:
      opts.findById ??
      jest.fn().mockResolvedValue({
        id: 'uid-1',
        email: 'a@b.com',
        passwordHash: '$2b$12$xxx',
        createdAt: new Date('2026-05-01T00:00:00Z'),
      }),
  } as unknown as UsersRepository;
  return { ctrl: new AuthController(auth, users), auth, users };
}

const principal: AuthenticatedUser = { id: 'uid-1', email: 'a@b.com' } as AuthenticatedUser;

describe('AuthController.signup', () => {
  it('delegates the DTO fields to AuthService.signup verbatim', async () => {
    const { ctrl, auth } = makeController();
    await ctrl.signup({ email: 'x@y.com', password: 'pw-long-enough-12' });
    expect(auth.signup).toHaveBeenCalledWith('x@y.com', 'pw-long-enough-12');
  });
});

describe('AuthController.login', () => {
  it('delegates the DTO fields to AuthService.login verbatim', async () => {
    const { ctrl, auth } = makeController();
    await ctrl.login({ email: 'x@y.com', password: 'pw' });
    expect(auth.login).toHaveBeenCalledWith('x@y.com', 'pw');
  });
});

describe('AuthController.me', () => {
  it('returns the SafeUser shape (no passwordHash leak)', async () => {
    const { ctrl } = makeController();
    const out = await ctrl.me(principal);
    expect(out).toEqual({
      id: 'uid-1',
      email: 'a@b.com',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    expect(out).not.toHaveProperty('passwordHash');
  });

  it('looks up the user by the @CurrentUser principal id', async () => {
    const findById = jest.fn().mockResolvedValue({
      id: 'uid-X',
      email: 'x@y.com',
      passwordHash: 'h',
      createdAt: new Date(),
    });
    const { ctrl } = makeController({ findById });
    await ctrl.me({ id: 'uid-X', email: 'x@y.com' } as AuthenticatedUser);
    expect(findById).toHaveBeenCalledWith('uid-X');
  });

  it('throws 404 when @CurrentUser is absent (defensive)', async () => {
    const { ctrl } = makeController();
    await expect(ctrl.me(undefined)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the user row no longer exists', async () => {
    const findById = jest.fn().mockResolvedValue(null);
    const { ctrl } = makeController({ findById });
    await expect(ctrl.me(principal)).rejects.toThrow(/User uid-1 not found/);
  });
});
