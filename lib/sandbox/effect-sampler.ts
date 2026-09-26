/**
 * The host side of custom-effect sampling: a SECOND sandbox — its own
 * opaque-origin supervisor frame and worker, the same runtime bundle as the
 * overlay sandbox — that runs nothing but custom effect `animate.js` bodies
 * and answers each with a table of numbers (lib/effects/curve.ts).
 *
 * Why a sandbox of its own rather than a message on the overlay sandbox:
 * sampling is one synchronous run of a body the overlay host's watchdog does
 * not know how to attribute, and a wedged effect would otherwise stall, and
 * get blamed on, the code overlays sharing the worker. Here the protocol is
 * one request at a time, so the request in flight is exactly what holds the
 * thread — or, when an `async` window is open, the body whose leftover work
 * it is — and a timeout restarts only this worker.
 *
 * Every answer is validated twice: the wire's zod schema (size-bounded), then
 * `sanitizeCurve`, which checks every number — the worker realm belongs to
 * the bodies, so nothing it sends is trusted.
 */
import { CURVE_SAMPLES, sanitizeCurve } from "@/lib/effects/curve";
import { LOAD_TIMEOUT_MS, PORT_MESSAGES_PER_SECOND, RESTART_BACKOFF_MS, type SandboxTransport } from "./host";
import { parseRuntimeMessage, parseSupervisorReply, type SampleMessage } from "./protocol";

/** How long one sample (compile + CURVE_SAMPLES calls) may take. */
export const SAMPLE_TIMEOUT_MS = LOAD_TIMEOUT_MS;
/** How long a fresh frame may take to say `ready` before every waiting sample fails. */
export const SAMPLER_BOOT_TIMEOUT_MS = 60_000;
/** Request ids remembered for blame; leftover work older than this many samples is not attributed. */
const EFFECT_OF_KEPT = 256;

export interface SampleRequest {
  effectId: string;
  source: string;
  sourceHash: string;
  params: Record<string, number | string>;
}

export interface EffectSamplerOptions {
  createTransport(nonce: string): SandboxTransport;
  sampleTimeoutMs?: number;
  bootTimeoutMs?: number;
  restartBackoffMs?: number;
  samples?: number;
  nonce?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Job {
  id: string;
  req: SampleRequest;
  resolve: (curve: Float64Array) => void;
  reject: (err: Error) => void;
}

/** What a failed sample says, naming the effect. */
export function sampleFailure(effectId: string, reason: string): string {
  return `custom effect "${effectId}" could not be sampled in the sandbox: ${reason}`;
}

export class EffectSampler {
  private transport: SandboxTransport | null = null;
  private port: MessagePort | null = null;
  private readonly nonce: string;
  private readonly queue: Job[] = [];
  private inFlight: Job | null = null;
  /** The request whose leftover work (a timer it set) is running now. */
  private openAsync: string | null = null;
  /** Effects whose body kept the worker busy after it answered: failed for good. */
  private readonly poisoned = new Map<string, string>();
  private jobTimer: unknown = null;
  private bootTimer: unknown = null;
  private restartTimer: unknown = null;
  private seq = 0;
  private destroyed = false;
  private readonly samples: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Request id → the effect body it sampled (for blame by an `async` window);
   *  the newest EFFECT_OF_KEPT only. */
  private readonly effectOf = new Map<string, { effectId: string; sourceHash: string }>();

  constructor(private readonly opts: EffectSamplerOptions) {
    this.nonce = (opts.nonce ?? (() => crypto.randomUUID()))();
    this.samples = opts.samples ?? CURVE_SAMPLES;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Sample one effect at `params`. Rejects with a message naming the effect. */
  sample(req: SampleRequest): Promise<Float64Array> {
    if (this.destroyed) return Promise.reject(new Error(sampleFailure(req.effectId, "the effect sandbox was closed")));
    const poison = this.poisoned.get(`${req.effectId}\u0000${req.sourceHash}`);
    if (poison) return Promise.reject(new Error(sampleFailure(req.effectId, poison)));
    return new Promise<Float64Array>((resolve, reject) => {
      this.queue.push({ id: `fx-${++this.seq}`, req, resolve, reject });
      this.pump();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of [this.jobTimer, this.bootTimer, this.restartTimer]) if (t !== null) this.clearTimer(t);
    this.failAll("the effect sandbox was closed");
    this.port?.close();
    this.port = null;
    this.transport?.destroy();
    this.transport = null;
  }

  private pump(): void {
    if (this.destroyed || this.inFlight || this.queue.length === 0) return;
    if (!this.transport) {
      this.mount();
      return;
    }
    if (!this.port) return; // waiting for `ready`
    const job = this.queue.shift()!;
    this.inFlight = job;
    this.effectOf.set(job.id, { effectId: job.req.effectId, sourceHash: job.req.sourceHash });
    if (this.effectOf.size > EFFECT_OF_KEPT) this.effectOf.delete(this.effectOf.keys().next().value!);
    const msg: SampleMessage = {
      t: "sample",
      id: job.id,
      source: job.req.source,
      sourceHash: job.req.sourceHash,
      params: job.req.params,
      samples: this.samples,
    };
    this.jobTimer = this.setTimer(() => this.expire(job), this.opts.sampleTimeoutMs ?? SAMPLE_TIMEOUT_MS);
    this.port.postMessage(msg);
  }

  private mount(): void {
    const transport = this.opts.createTransport(this.nonce);
    this.transport = transport;
    transport.onReply((data, source) => {
      if (this.destroyed || this.transport !== transport || !transport.peer || source !== transport.peer) return;
      const msg = parseSupervisorReply(data);
      if (!msg || msg.nonce !== this.nonce) return;
      if (msg.t === "ready") this.adopt(msg.port);
      else if (msg.t === "supervisorError" && !this.port) this.bootFailed(msg.message);
    });
    this.armBoot();
  }

  private armBoot(): void {
    if (this.bootTimer !== null) this.clearTimer(this.bootTimer);
    this.bootTimer = this.setTimer(() => {
      this.bootTimer = null;
      if (this.destroyed || this.port) return;
      // A frame that never says `ready`: drop it; the next sample mounts a new one.
      this.failAll("the effect sandbox did not start");
      this.transport?.destroy();
      this.transport = null;
    }, this.opts.bootTimeoutMs ?? SAMPLER_BOOT_TIMEOUT_MS);
  }

  private adopt(port: MessagePort): void {
    this.port?.close();
    if (this.bootTimer !== null) this.clearTimer(this.bootTimer);
    this.bootTimer = null;
    this.port = port;
    this.openAsync = null;
    let windowStart = Date.now();
    let count = 0;
    port.onmessage = (ev: MessageEvent) => {
      if (this.destroyed || this.port !== port) return;
      // Counted BEFORE `ev.data` is read (it deserializes on first read): a
      // body flooding the port through its leftover work is a wedge, and is
      // recovered as one — blamed, and this worker restarted.
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > PORT_MESSAGES_PER_SECOND) {
        this.flood();
        return;
      }
      const msg = parseRuntimeMessage(ev.data);
      if (!msg || msg.nonce !== this.nonce) return;
      if (msg.t === "async") this.openAsync = msg.id;
      else if (msg.t === "asyncDone" && this.openAsync === msg.id) this.openAsync = null;
      else if (msg.t === "curve" || msg.t === "error") this.answer(msg.id, msg);
    };
    port.start?.();
    this.pump();
  }

  private answer(id: string, msg: { t: "curve"; samples: number; data: ArrayBuffer } | { t: "error"; message: string; line?: number }): void {
    const job = this.inFlight;
    if (!job || job.id !== id) return;
    this.finish();
    if (msg.t === "error") {
      job.reject(new Error(sampleFailure(job.req.effectId, msg.line ? `${msg.message} (line ${msg.line})` : msg.message)));
    } else {
      const curve = msg.samples === this.samples ? sanitizeCurve(msg.data, msg.samples) : null;
      if (curve) job.resolve(curve);
      else job.reject(new Error(sampleFailure(job.req.effectId, "the sandbox answered with a malformed curve")));
    }
    this.pump();
  }

  private finish(): void {
    if (this.jobTimer !== null) this.clearTimer(this.jobTimer);
    this.jobTimer = null;
    this.inFlight = null;
  }

  /**
   * The request in flight got no answer in time. The worker is wedged: by this
   * body, or — when an `async` window is open — by work an EARLIER body left
   * running, which is then the one blamed (and refused from here on for that
   * source). Either way only this sandbox's worker is restarted.
   */
  private expire(job: Job): void {
    this.jobTimer = null;
    if (this.inFlight !== job || this.destroyed) return;
    this.inFlight = null;
    const culprit = this.openAsync ? this.effectOf.get(this.openAsync) : undefined;
    const secs = Math.round((this.opts.sampleTimeoutMs ?? SAMPLE_TIMEOUT_MS) / 1000);
    if (culprit && !(culprit.effectId === job.req.effectId && culprit.sourceHash === job.req.sourceHash)) {
      this.poison(culprit, "work its animate body leaves running after it returns blocked the effect sandbox");
      // The request in flight was only blocked: ask again once the worker is back.
      this.queue.unshift(job);
    } else {
      job.reject(new Error(sampleFailure(job.req.effectId, `animate did not finish sampling within ${secs} s — a loop that never ends, or far too much work per call`)));
    }
    this.restart();
  }

  /** The port went over its message budget: blame whoever holds the thread
   *  (the open `async` window's body, else the request in flight). */
  private flood(): void {
    const culprit = (this.openAsync ? this.effectOf.get(this.openAsync) : undefined) ??
      (this.inFlight ? { effectId: this.inFlight.req.effectId, sourceHash: this.inFlight.req.sourceHash } : undefined);
    const job = this.inFlight;
    this.finish();
    if (job) this.queue.unshift(job);
    if (culprit) this.poison(culprit, "its animate body flooded the effect sandbox's channel to the studio");
    this.restart();
  }

  /** Refuse this body (effect + exact source) from now on — a changed source is
   *  tried again — and fail every queued request for it. */
  private poison(body: { effectId: string; sourceHash: string }, reason: string): void {
    this.poisoned.set(`${body.effectId}\u0000${body.sourceHash}`, reason);
    const keep: Job[] = [];
    for (const j of this.queue.splice(0)) {
      if (j.req.effectId === body.effectId && j.req.sourceHash === body.sourceHash) j.reject(new Error(sampleFailure(body.effectId, reason)));
      else keep.push(j);
    }
    this.queue.push(...keep);
  }

  private restart(): void {
    this.port?.close();
    this.port = null;
    this.openAsync = null;
    if (!this.transport) return;
    this.transport.command({ t: "restart", nonce: this.nonce });
    this.armBoot();
  }

  private bootFailed(message: string): void {
    // The worker would not start: every waiting sample fails now, and the next
    // restart is asked for no sooner than the backoff.
    this.failAll(`the effect sandbox could not start (${message})`);
    if (this.restartTimer !== null) return;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      if (this.destroyed || this.port || !this.transport) return;
      this.transport.command({ t: "restart", nonce: this.nonce });
    }, this.opts.restartBackoffMs ?? RESTART_BACKOFF_MS);
  }

  private failAll(reason: string): void {
    const jobs = [...(this.inFlight ? [this.inFlight] : []), ...this.queue.splice(0)];
    this.finish();
    for (const j of jobs) j.reject(new Error(sampleFailure(j.req.effectId, reason)));
  }
}
