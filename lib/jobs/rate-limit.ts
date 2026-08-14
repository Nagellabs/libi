/**
 * Rate limiter for COST-BEARING ("paid") background-job enqueues.
 *
 * Threat model (RC-E): the Next.js server binds localhost with no auth. The
 * CSRF middleware blocks cross-origin browser requests, but this limiter is
 * defence-in-depth against a same-origin runaway (a buggy loop, or any residual
 * path past the CSRF guard) racking up unbounded provider billing.
 *
 * Only the enqueue paths that spend money on an external provider API are
 * limited. Everything local (proxy/filmstrip generation, exports, local
 * tracking, model downloads, music diffusion) bypasses the limiter entirely —
 * a runaway there wastes CPU, not dollars.
 *
 * The limiter is applied in `POST /api/jobs` before the job is enqueued. The
 * MCP stdio child enqueues through that same HTTP route, so it is naturally
 * covered. Internal, non-HTTP enqueues (e.g. `enqueueProxyGen` calling
 * `JobManager.enqueue` directly) are NOT limited — they are all non-paid kinds.
 */

import { getRunner } from "@/lib/jobs/runners/registry";

/** True when a job kind spends money on an external provider on `run()`.
 *
 *  Truth is sourced structurally from the runner's `paid: true` flag (see
 *  `JobRunner` in `lib/jobs/types.ts`), NOT a hand-maintained list — so a new
 *  paid runner cannot silently bypass this billing limiter by being forgotten
 *  in a literal. Today that flag is set on `tracking_provider` (fal.ai SAM2)
 *  and `extra_analysis_model` (fal.ai video-understanding); every other kind
 *  is local compute and returns false.
 *
 *  The registry lookup is valid here because this runs in the Next.js process
 *  (`POST /api/jobs`), where `registerBuiltinRunners()` has populated the
 *  registry. An unregistered kind resolves to null → non-paid (fail-open on
 *  classification is acceptable: the limiter is defence-in-depth, and only
 *  registered runners can actually enqueue work). */
export function isPaidJobKind(kind: string): boolean {
  return getRunner(kind)?.paid === true;
}

/** Rolling window over which paid enqueues are counted. */
export const PAID_JOB_RATE_WINDOW_MS = 60_000;

/** Max paid enqueues allowed per rolling window. Chosen deliberately generous:
 *  every paid generation is user-approved and takes tens of seconds to minutes,
 *  so a legitimate human/agent cadence never approaches 10/min. The bound only
 *  bites an automated runaway. */
export const PAID_JOB_RATE_LIMIT = 10;

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest in-window hit expires (0 when allowed). */
  retryAfterMs: number;
}

/**
 * In-memory sliding-window counter. Clock is injectable (`now` param) so tests
 * drive time deterministically — no real timers, no `Date.now()` flakiness.
 */
export class SlidingWindowRateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Check-and-consume one hit at time `now`. When allowed, records the hit and
   *  returns `{ allowed: true }`. When the window is full, records nothing and
   *  returns how long until a slot frees. */
  check(now: number): RateLimitDecision {
    const cutoff = now - this.windowMs;
    // Drop hits that have aged out of the window.
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0];
      return {
        allowed: false,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }
    this.hits.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(): void {
    this.hits = [];
  }
}

// Process-local singleton — survives Next.js HMR via the globalThis cache, so a
// module reload can't silently reset the budget mid-abuse.
declare global {
  // eslint-disable-next-line no-var
  var __libiPaidJobLimiter: SlidingWindowRateLimiter | undefined;
}

function getPaidJobLimiter(): SlidingWindowRateLimiter {
  if (!globalThis.__libiPaidJobLimiter) {
    globalThis.__libiPaidJobLimiter = new SlidingWindowRateLimiter(
      PAID_JOB_RATE_LIMIT,
      PAID_JOB_RATE_WINDOW_MS,
    );
  }
  return globalThis.__libiPaidJobLimiter;
}

/**
 * Check-and-consume the shared paid-job budget for one enqueue of `kind`.
 * Non-paid kinds always pass and consume no budget. A single global bucket
 * across all paid kinds bounds total provider spend regardless of which
 * provider is targeted.
 */
export function checkPaidJobRateLimit(
  kind: string,
  now: number = Date.now(),
): RateLimitDecision {
  if (!isPaidJobKind(kind)) return { allowed: true, retryAfterMs: 0 };
  return getPaidJobLimiter().check(now);
}

/** Test-only: clear the process-local paid-job budget. */
export function __resetPaidJobRateLimiterForTests(): void {
  globalThis.__libiPaidJobLimiter = undefined;
}
