import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../database/prisma.service';

const TOKEN_TTL_MS = 60 * 60 * 1000;
const SECRET_BYTES = 32;
const BCRYPT_ROUNDS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintedToken {
  token: string;
  sessionId: string;
  expiresInMinutes: number;
  // CLI uses this to filter Claude Code log files whose first turn
  // predates the build phase — those are unrelated sessions on the
  // same project from before the candidate clicked Start-build.
  buildStartedAt: Date;
}

export interface VerifiedToken {
  sessionId: string;
}

// Token format: `<sessionId>.<secret>`. The sessionId half lets the
// guard look up the row in O(1); the secret half is what authenticates.
// We store only bcrypt(secret) on the row, so a leaked DB dump can't be
// replayed against the API.
@Injectable()
export class BuildTokenService {
  private readonly logger = new Logger(BuildTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  async mintForSession(sessionId: string): Promise<MintedToken> {
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    const hash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
    const buildStartedAt = new Date();
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        buildTokenHash: hash,
        buildStartedAt,
        buildEndedAt: null,
      },
    });
    this.logger.log(`Minted build token for session ${sessionId}`);
    return {
      token: `${sessionId}.${secret}`,
      sessionId,
      expiresInMinutes: TOKEN_TTL_MS / 60_000,
      buildStartedAt,
    };
  }

  async verify(rawToken: string | undefined): Promise<VerifiedToken | null> {
    if (!rawToken) return null;
    const idx = rawToken.indexOf('.');
    if (idx <= 0 || idx === rawToken.length - 1) return null;
    const sessionId = rawToken.slice(0, idx);
    const secret = rawToken.slice(idx + 1);
    // Pre-validate the id half is a UUID so a malformed token doesn't
    // make Prisma throw on the lookup (column type is uuid).
    if (!UUID_RE.test(sessionId)) return null;

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        buildTokenHash: true,
        buildStartedAt: true,
        buildEndedAt: true,
        status: true,
      },
    });
    if (!session) return null;
    if (!session.buildTokenHash) return null;
    if (session.status === 'abandoned') return null;
    if (session.buildEndedAt) return null;
    if (
      session.buildStartedAt &&
      Date.now() - session.buildStartedAt.getTime() > TOKEN_TTL_MS
    ) {
      return null;
    }
    const ok = await bcrypt.compare(secret, session.buildTokenHash);
    if (!ok) return null;
    return { sessionId: session.id };
  }
}
