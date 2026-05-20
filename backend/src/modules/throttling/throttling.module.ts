import { Module } from '@nestjs/common';
import { ThrottlerModule, seconds, minutes, hours } from '@nestjs/throttler';
import { UserOrIpThrottlerGuard } from './user-or-ip-throttler.guard';

// Three global tiers. All three apply to every request; @Throttle()
// on a specific handler tightens any of them per-route.
//
//   short   10/sec  per tracker  — prevents flood from automated clients
//   medium  60/min  per tracker  — averages 1/sec sustained
//   long    600/hr  per tracker  — daily-ish ceiling on volume
//
// "Tracker" = req.user.id when authenticated, else req.ip
// (see UserOrIpThrottlerGuard.getTracker). This means anonymous
// callers share the IP-keyed bucket while authenticated callers get
// their own per-user bucket — one abusive user can't burn another
// user's budget by sharing an IP (and vice versa).
//
// Throttler state is in-memory by default. For a single-instance
// deployment that's fine; multi-instance needs a Redis storage
// adapter (deferred until horizontal scaling lands).
@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'short', ttl: seconds(1), limit: 10 },
      { name: 'medium', ttl: minutes(1), limit: 60 },
      { name: 'long', ttl: hours(1), limit: 600 },
    ]),
  ],
  providers: [UserOrIpThrottlerGuard],
  exports: [UserOrIpThrottlerGuard],
})
export class ThrottlingModule {}
