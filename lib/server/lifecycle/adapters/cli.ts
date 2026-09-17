import ora, { type Ora } from "ora";
import type { LifecycleAdapter, LifecycleEvent } from "../types";

/** What a terminal that will not say how wide it is gets treated as. */
export const FALLBACK_COLUMNS = 80;

/**
 * Make a TTY that reports **zero** columns report 80 instead.
 *
 * ora divides by the stream's width to decide how many lines to erase:
 * `Math.max(1, Math.ceil(width / columns))` with `columns = stream.columns ?? 80`.
 * A pty reporting `columns === 0` is neither null nor undefined, so `??` does
 * not catch it — the division yields `Infinity`, and `clear()` then loops
 * `for (index = 0; index < Infinity; index++)` emitting `ESC[1A ESC[0K`
 * forever. Measured: ~5 MB/s of escape codes, the process pegged at 98 % CPU,
 * the event loop starved so the Node.js runtime download made ZERO bytes of
 * progress, and after 21 minutes a 6.5 GB log and a boot that never finished.
 * A 100x30 pty boots the same tree in 32.8 s.
 *
 * `script -q` is the reproduction, but any 0-column context does it — some CI
 * log captures report the same. A getter rather than a one-shot assignment
 * because node re-assigns `columns` from `_refreshSize()` on every SIGWINCH,
 * and a resize back to 0 would otherwise restore the hang.
 *
 * ora is the only thing in libi that reads a terminal width at all (nothing
 * else in the tree touches `.columns`), so this is the one seam that needs it.
 */
export function guardStreamColumns(stream: { isTTY?: boolean; columns?: number }): void {
  if (!stream.isTTY) return;
  let current = stream.columns;
  Object.defineProperty(stream, "columns", {
    configurable: true,
    enumerable: true,
    get: () => (typeof current === "number" && current > 0 ? current : FALLBACK_COLUMNS),
    set: (value: number) => {
      current = value;
    },
  });
}

export function cliAdapter(): LifecycleAdapter {
  const spinners = new Map<string, Ora>();

  // ora renders to stderr; stdout is guarded too because this adapter writes
  // plain lines there and a future spinner could be pointed at it.
  guardStreamColumns(process.stderr);
  guardStreamColumns(process.stdout);

  /**
   * Snake_case tokens are not user copy. The emit sites use prose, but
   * this adapter prints whatever `reason` arrives — including `needs_config`
   * and anything a future emitter forgets to spell out — so tokens are
   * de-tokenised here as well. A reason that is already prose passes through
   * unchanged (there is no `_` in it to replace).
   */
  function prose(reason: string): string {
    return reason.replace(/_/g, " ");
  }

  function fmtBytes(b: number): string {
    if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  return {
    onEvent(e: LifecycleEvent) {
      switch (e.kind) {
        case "prelude-start":
          process.stdout.write("\n[libi] Setting up…\n\n");
          break;

        case "category-a-install-start": {
          // Default text is "Verifying" — accurate on the hot path where
          // nothing actually downloads. Switches to "Downloading" when
          // an install-progress event arrives with bytes.
          const sp = ora(`Verifying ${e.item.label}`).start();
          spinners.set(`install:${e.item.id}`, sp);
          break;
        }

        case "category-a-install-progress": {
          const key = `install:${e.item.id}`;
          let sp = spinners.get(key);
          if (!sp) {
            sp = ora(`Downloading ${e.item.label}`).start();
            spinners.set(key, sp);
          }
          // `detail` wins when set: it carries progress for installs libi
          // can't count bytes for (npm), where the byte fields are 0/null and
          // would render a permanent "(0 B)".
          if (e.detail) {
            sp.text = `Downloading ${e.item.label} (${e.detail})`;
          } else if (e.bytesDownloaded > 0 || e.bytesTotal) {
            const total = e.bytesTotal ? ` / ${fmtBytes(e.bytesTotal)}` : "";
            sp.text = `Downloading ${e.item.label} (${fmtBytes(e.bytesDownloaded)}${total})`;
          }
          // A tick with no detail, no total and no bytes carries no news, and
          // rendering it wrote `(0 B)`. The download opens with one of those
          // (dependency-manager emits a bare `downloading` before the response
          // headers land) and CLOSES with one (`extracting` carries no byte
          // fields), so a finished 27.1 MB download flashed back to `(0 B)`
          // for two frames right before its tick — which reads as a restart.
          // Leave the row saying whatever it last said.
          break;
        }

        case "category-a-install-done": {
          // A dep decided on disk arrives as done/skipped with NO prior
          // install-start — a token-matched binary (category-a.ts opens no row
          // for it) or an already-managed node runtime, whose start event is
          // now emitted lazily from the first progress tick. EVERY
          // branch has to tolerate the missing spinner: `sp?.warn(...)` on a
          // failed node runtime printed nothing at all.
          const sp = spinners.get(`install:${e.item.id}`) ?? ora();
          if (e.result === "skipped") sp.info(`${e.item.label}: ${prose(e.reason ?? "skipped")}`);
          else if (e.result === "failed") sp.warn(`${e.item.label}: ${e.reason ?? "install failed"}`);
          else sp.succeed(`${e.item.label}`);
          spinners.delete(`install:${e.item.id}`);
          break;
        }

        case "category-a-done":
          process.stdout.write(`\n[libi] Setup complete (${e.durationMs}ms)\n`);
          break;

        case "category-b-step":
          // Category B runs in the Next.js process; the CLI parent doesn't
          // render its steps. They'll appear in the splash / browser UI.
          break;

        case "category-b-done":
          // Same as above — CLI doesn't render Category B's completion.
          break;

        case "warning":
          // Boot carries on, so no spinner is failed and nothing exits; the
          // line goes to stderr so it is not lost among the progress output.
          process.stderr.write(`\n[libi] Warning: ${e.message}\n\n`);
          break;

        case "fatal":
          // Stop any active spinners with a fail mark.
          for (const sp of spinners.values()) sp.fail();
          spinners.clear();
          process.stderr.write(
            [
              "",
              `✗ ${e.phase}${e.step ? ` / ${e.step}` : ""} failed`,
              "",
              `  ${e.error}`,
              "",
              `  ${e.hint.split("\n").join("\n  ")}`,
              "",
            ].join("\n") + "\n",
          );
          break;

        case "server-listening":
          process.stdout.write(`[libi] Server listening on ${e.url}\n`);
          break;
      }
    },
  };
}
