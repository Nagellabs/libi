/**
 * The export lane: one export encodes at a time on this machine, and a user's
 * export never waits behind work nobody asked to watch.
 *
 * Why one at a time is the `export` runner's `maxConcurrent: 1`
 * (lib/jobs/runners/export.ts): h264_videotoolbox is a single-session encoder
 * on older Macs, and libx264 at `-preset slow` saturates the CPU. That slot
 * serialises the `export` JOBS, but two other callers render a piece without
 * an export job — so that no export row is ever recorded for them (an example
 * render must never read as the piece's latest export: D2–D4 review I1):
 *
 *  - FOREGROUND: the `export` job itself, and a publish preparation's export
 *    of the piece the user named (`template_publish_prepare`). Someone is
 *    waiting on each. Served in arrival order.
 *  - BACKGROUND: the Templates page's example render (`template_example`),
 *    started by `libi.create_template_from_piece` or Render preview. It
 *    starts only while no foreground export runs or waits (nor, per `busy`,
 *    sits queued for the export job's own slot), at most one at a time, and
 *    YIELDS the moment a foreground export arrives: its signal aborts with a
 *    `BackgroundYield`, the foreground export starts as soon as it has let go
 *    (ffmpeg is SIGKILLed on abort, so that is quick), and the render runs
 *    again from the start once the lane is free (D2–D4 review I2).
 *
 * In-process state, like JobManager's own slots: one Next server runs every
 * export. `pollMs` bounds how late a waiting background render notices a
 * `busy` probe going quiet — the probe reads JobManager, which signals nothing.
 */

/** The reason a background render's signal aborts when a foreground export takes the lane. */
export class BackgroundYield extends Error {
  constructor() {
    super("an export the user asked for took the export lane");
    this.name = "BackgroundYield";
  }
}

/** By name, not `instanceof`: each Next route bundle has its own copy of this module. */
export function isBackgroundYield(err: unknown): boolean {
  return err instanceof Error && err.name === "BackgroundYield";
}

export interface BackgroundSlot {
  /** Aborts (reason: `BackgroundYield`) when a foreground export arrives. */
  signal: AbortSignal;
  /** Give the lane back. Idempotent. */
  release: () => void;
}

const DEFAULT_POLL_MS = 250;

export class ExportLane {
  private readonly pollMs: number;
  /** A foreground export holds the lane — or is being handed it by the one before. */
  private fgHeld = false;
  private fgQueue: Array<() => void> = [];
  private bg: { ac: AbortController; letGo: Promise<void>; resolveLetGo: () => void } | null = null;
  private wakers = new Set<() => void>();

  constructor(opts: { pollMs?: number } = {}) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  /**
   * Take the lane for an export someone is waiting on. Resolves once every
   * earlier foreground export is done and a background render in progress
   * has let go (it is told to at once). Returns the release. `signal`
   * aborting while it waits rejects with its reason and gives up the place.
   */
  async foreground(opts: { signal?: AbortSignal } = {}): Promise<() => void> {
    const { signal } = opts;
    if (signal?.aborted) throw abortReason(signal);
    // Ownership is HANDED to the next waiter (fgHeld stays true), so nothing
    // — least of all a background render — slips in between two exports.
    // A waiter whose job is cancelled leaves the queue at once, holding no place.
    if (this.fgHeld) {
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          signal?.removeEventListener("abort", leave);
          resolve();
        };
        const leave = () => {
          const i = this.fgQueue.indexOf(turn);
          if (i >= 0) this.fgQueue.splice(i, 1);
          reject(abortReason(signal!));
        };
        this.fgQueue.push(turn);
        signal?.addEventListener("abort", leave, { once: true });
      });
    }
    this.fgHeld = true;
    const bg = this.bg;
    if (bg) {
      if (!bg.ac.signal.aborted) bg.ac.abort(new BackgroundYield());
      // A cancel still works while a yielding render tears down (final review F8): the lane is handed on.
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          bg.letGo,
          new Promise<never>((_resolve, reject) => {
            if (!signal) return;
            onAbort = () => reject(abortReason(signal));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } catch (err) {
        this.handOn();
        throw err;
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handOn();
    };
  }

  /** Give a held foreground turn to the next waiter, or free the lane. */
  private handOn(): void {
    const next = this.fgQueue.shift();
    if (next) {
      next();
      return;
    }
    this.fgHeld = false;
    this.wake();
  }

  /** A foreground export holds the lane or waits for it: a new one would have to wait its turn. */
  foregroundBusy(): boolean {
    return this.fgHeld;
  }

  /**
   * Take the lane for a render nobody is waiting on. Waits while a
   * foreground export runs or waits, while `busy()` is true, or while another
   * background render holds it. Rejects with `signal`'s reason when the
   * caller's own job is cancelled while waiting.
   */
  async background(opts: { signal?: AbortSignal; busy?: () => boolean } = {}): Promise<BackgroundSlot> {
    const { signal, busy } = opts;
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      if (!this.fgHeld && !this.bg && !(busy?.() ?? false)) break;
      await this.nextChange(signal);
    }
    const ac = new AbortController();
    let resolveLetGo = () => {};
    const letGo = new Promise<void>((resolve) => (resolveLetGo = resolve));
    const mine = { ac, letGo, resolveLetGo };
    this.bg = mine;
    return {
      signal: ac.signal,
      release: () => {
        if (this.bg !== mine) return;
        this.bg = null;
        mine.resolveLetGo();
        this.wake();
      },
    };
  }

  /** Resolves on the lane's next change, after `pollMs` at most (for `busy`), or when `signal` aborts. */
  private nextChange(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      this.wakers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("cancelled");
}

// One lane per process — survives Next.js HMR via globalThis, as JobManager does.
declare global {
  var __libiExportLane: ExportLane | undefined;
}

export function getExportLane(): ExportLane {
  if (!globalThis.__libiExportLane) globalThis.__libiExportLane = new ExportLane();
  return globalThis.__libiExportLane;
}
