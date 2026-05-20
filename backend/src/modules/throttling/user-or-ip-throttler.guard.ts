import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../auth/types/auth.types';

// Default ThrottlerGuard tracks by IP only. We swap to:
//   - req.user.id  if the global AuthGuard already attached a user
//                  (i.e. the request carries a valid JWT)
//   - req.ip       fall-through for @Public() routes (signup, login)
//                  and @CliAuthenticated routes that bypass AuthGuard
//
// Tracking by user means a single bad actor can't drain another
// user's throttle budget just by sharing a NAT'd IP — common on
// corporate networks. IP fallback for anonymous still prevents the
// classic curl-loop attack on the login endpoint.
//
// Guard ordering matters: in AppModule's APP_GUARD chain, AuthGuard
// runs FIRST so req.user is populated before getTracker is called.
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: AuthenticatedRequest): Promise<string> {
    if (req.user?.id) return `user:${req.user.id}`;
    return `ip:${req.ip ?? 'unknown'}`;
  }
}
