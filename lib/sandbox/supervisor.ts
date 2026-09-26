/**
 * The supervisor's logic (spec A1 §1, §3, §4), DOM-free so it is unit-tested:
 * spawn a worker, give it one end of a MessageChannel, hand the other end to
 * the host inside `ready`; on `restart` terminate and do it again; answer
 * `ping` with `pong`. This thread never runs a body, so it is never wedged —
 * which is the whole reason recovery works where destroying the iframe did not.
 */
import { parseSupervisorCommand, WORKER_BOOTED } from "./protocol-supervisor";
import type { ReadyMessage, SupervisorReply, WorkerInit } from "./protocol";

/** A port whose other end has been transferred away is detached in this realm;
 *  `close()` on it is a no-op in Chromium but must never break a restart. */
function closeQuietly(port: MessagePort | undefined): void {
  try {
    port?.close();
  } catch {
    // detached, or a host object that cannot be closed — nothing to do
  }
}

/**
 * Per-worker boot gate (Task 4 re-review ruling). The supervisor relays a
 * worker's `error` / `messageerror` as `supervisorError` ONLY until that worker
 * says it booted (`WORKER_BOOTED` on the supervisor's own channel).
 *
 * Before the handshake, an error means the worker never came up — a CSP
 * refusal, a syntax error in the bundle — and nothing else would ever tell the
 * host. After it, the worker installs its own `error` / `unhandledrejection`
 * handlers and turns a body's failure into an `error { id, phase, line, … }` on
 * the port; relaying the same throw as a `supervisorError` too would report it
 * twice, without a position, and against whatever the host happened to have in
 * flight.
 */
export function createBootGate(): { onWorkerMessage(data: unknown): void; relays(): boolean } {
  let booted = false;
  return {
    onWorkerMessage(data: unknown): void {
      if (typeof data === "object" && data !== null && (data as { t?: unknown }).t === WORKER_BOOTED) booted = true;
    },
    relays: () => !booted,
  };
}

/**
 * The part of a `Worker` the boot relay listens on. Structural, so the dev-only
 * in-origin transport's tests can hand in a fake; a real `Worker` satisfies it.
 */
export interface BootWatchedWorker {
  addEventListener(type: "message", handler: (ev: MessageEvent) => void): void;
  addEventListener(type: "error", handler: (ev: ErrorEvent) => void): void;
  addEventListener(type: "messageerror", handler: (ev: MessageEvent) => void): void;
}

/**
 * Wire a freshly spawned worker's boot-failure relay (see `createBootGate`):
 * `fail` hears a worker `error` / `messageerror` only until the worker's
 * `WORKER_BOOTED` handshake, which is consumed here and goes nowhere else.
 * Shared by the supervisor page and the in-origin transport, so both treat
 * the handshake identically.
 */
export function relayBootFailures(worker: BootWatchedWorker, fail: (message: string) => void): void {
  const gate = createBootGate();
  worker.addEventListener("message", (ev) => gate.onWorkerMessage(ev.data));
  // A worker that dies on BOOT (a syntax error in the bundle, a CSP refusal)
  // never answers, and the host would only ever see the watchdog time out. The
  // `error` event is the one place that failure is nameable, so it is relayed
  // rather than swallowed; `messageerror` catches a payload that crossed the
  // boundary uncloneable.
  worker.addEventListener("error", (ev) => {
    if (gate.relays()) fail(`worker error: ${ev.message || describeError(ev.error) || "(no message)"}`);
    // After boot the worker cancels its own uncaught errors, so none should
    // arrive; one that does is dropped here too, not logged to this console.
    else ev.preventDefault();
  });
  worker.addEventListener("messageerror", () => {
    if (gate.relays()) fail("worker messageerror: a message could not be deserialized");
  });
}

export interface SupervisorWorker {
  postMessage(msg: WorkerInit, transfer: Transferable[]): void;
  terminate(): void;
}

export interface SupervisorDeps {
  nonce: string;
  /** The literal `PROTOCOL_VERSION` — `ready` pins it, so a drift is a type error. */
  version: ReadyMessage["version"];
  spawn(): SupervisorWorker;
  channel(): { port1: MessagePort; port2: MessagePort };
  /** Post to the host (the embedding window). */
  reply(msg: SupervisorReply, transfer: Transferable[]): void;
}

export interface Supervisor {
  start(): void;
  generation(): number;
  /** `fromParent` is `event.source === window.parent` — the only sender trusted. */
  handle(data: unknown, fromParent: boolean): void;
}

/** The wire caps `message` at 2000 chars (protocol.ts); stay inside it or the
 *  host's parser drops the very diagnostic this exists to deliver. */
export function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text || "unknown error").slice(0, 2000);
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let worker: SupervisorWorker | null = null;
  let channel: { port1: MessagePort; port2: MessagePort } | null = null;
  let generation = 0;

  const start = (): void => {
    worker?.terminate();
    worker = null;
    // The old pair goes with the old worker. Both ends were transferred away
    // (one to the worker, one to the host), so in this realm they are detached
    // and the close is a no-op — but the entanglement is released wherever the
    // transport did not transfer them, and the failure path below has a pair
    // that was never transferred at all.
    closeQuietly(channel?.port1);
    closeQuietly(channel?.port2);
    channel = null;

    const pair = deps.channel();
    let spawned: SupervisorWorker;
    try {
      spawned = deps.spawn();
    } catch (err) {
      // A worker that will not construct is the one failure the host cannot
      // see: it would wait out the load watchdog, restart, and wait again,
      // forever, with nothing to show the user. Say so instead.
      closeQuietly(pair.port1);
      closeQuietly(pair.port2);
      deps.reply({ t: "supervisorError", nonce: deps.nonce, message: describeError(err) }, []);
      return;
    }
    worker = spawned;
    channel = pair;
    generation++;
    worker.postMessage({ t: "init", nonce: deps.nonce, port: pair.port1 }, [pair.port1]);
    deps.reply({ t: "ready", nonce: deps.nonce, version: deps.version, port: pair.port2 }, [pair.port2]);
  };

  return {
    start,
    generation: () => generation,
    handle(data: unknown, fromParent: boolean): void {
      if (!fromParent) return;
      const cmd = parseSupervisorCommand(data);
      if (!cmd || cmd.nonce !== deps.nonce) return;
      if (cmd.t === "ping") deps.reply({ t: "pong", nonce: deps.nonce, ...(cmd.id !== undefined ? { id: cmd.id } : {}) }, []);
      else start();
    },
  };
}
