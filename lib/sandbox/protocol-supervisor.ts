/**
 * The sliver of the overlay-sandbox protocol the SUPERVISOR leg needs, kept
 * free of zod on purpose.
 *
 * The supervisor's script and the worker's are served as ONE bundle (the
 * worker's source rides inside the supervisor's as a string constant —
 * `lib/sandbox/runtime-bundle.ts`), so anything both legs import is paid for
 * TWICE over the wire. zod is ~550 KB of that, and the supervisor validates
 * exactly one shape: a two-command union with a nonce. Hand-writing that check
 * keeps the supervisor bundle at a few KB instead of half a megabyte; the
 * worker and the host keep the zod schemas in `protocol.ts`, which re-exports
 * everything here so there is still one import site for consumers that do not
 * care.
 *
 * `parseSupervisorCommand` must stay equivalent to what a zod
 * `discriminatedUnion` of these two objects would accept — a drift test in
 * `__tests__/unit/sandbox/protocol.test.ts` holds it to that.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The worker's handshake marker, posted on the SUPERVISOR's own channel
 * (`self.postMessage`) the moment the worker has adopted its port. It closes
 * the supervisor's boot-failure relay (`createBootGate`): before it, a worker
 * `error` means the worker never came up and the host would otherwise wait out
 * its watchdog with nothing to report; after it, the worker turns a body
 * failure into an `error { id, phase, … }` on the port and owns its own
 * diagnostics.
 */
export const WORKER_BOOTED = "booted";

/** `ping` may carry an `id`, which the `pong` echoes (re-review R-M5): the
 *  host correlates by it, so a ping that was never answered cannot put every
 *  later answer one behind. */
export type SupervisorCommand = { t: "restart"; nonce: string } | { t: "ping"; nonce: string; id?: number };

/** Same contract as every other parser here: unknown in, a validated value or
 *  `null` out, and unknown fields dropped rather than forwarded. */
export function parseSupervisorCommand(data: unknown): SupervisorCommand | null {
  if (typeof data !== "object" || data === null) return null;
  const { t, nonce, id } = data as { t?: unknown; nonce?: unknown; id?: unknown };
  if (t !== "restart" && t !== "ping") return null;
  if (typeof nonce !== "string" || nonce.length < 1) return null;
  if (t === "restart") return { t, nonce };
  if (id === undefined) return { t, nonce };
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return null;
  return { t, nonce, id };
}
