import { minutes, seconds } from '@nestjs/throttler';

// Reusable @Throttle() overrides for routes whose rate-limit profile
// differs from the global tiers in throttling.module.ts. Centralizing
// here means changing a cap is a one-line edit, not a sweep across
// every controller.
//
// ttl = sliding time window. ttl=seconds(1) means "max `limit`
// requests in any 1-second window per tracker" — it has nothing to do
// with how long the server takes to respond. An LLM call that runs
// for 15 seconds is still subject to the same per-second cap on how
// often a client can KICK OFF requests.

// LLM-bound POST routes (re-evaluate, hint send, mentor regen, etc.).
// 1/sec defeats runaway loops + accidental double-clicks.
// 20/min ceiling caps sustained per-user LLM-budget burn.
export const LLM_POST_THROTTLE = {
  short: { limit: 1, ttl: seconds(1) },
  medium: { limit: 20, ttl: minutes(1) },
};

// Unauthenticated auth endpoints (/auth/signup, /auth/login).
// 5/min per IP slows credential-stuffing and signup-spam to a crawl
// while still letting a legit user retry after a typo.
export const AUTH_BRUTE_FORCE_THROTTLE = {
  short: { limit: 5, ttl: minutes(1) },
  medium: { limit: 5, ttl: minutes(1) },
};
