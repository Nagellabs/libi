import type { Readable } from "node:stream";

/**
 * Wrap a Node `Readable` (e.g. `fs.createReadStream`, `child.stdout`) in a
 * Web `ReadableStream` that survives consumer cancels.
 *
 * `Readable.toWeb()` propagates an `Invalid state: Controller is already
 * closed` error when the consumer aborts — the adapter at
 * `node:internal/webstreams/adapters` calls `controller.enqueue` after the
 * abort closed the controller. Without a try/catch the error reaches
 * `process.on("uncaughtException")` and (with our policy) crashed the
 * server.
 *
 * This wrapper guards `enqueue` / `close` / `error` and destroys the
 * source on `cancel` so a disconnect is just a no-op.
 *
 * Backpressure is applied via `pause()`/`resume()` on the source stream,
 * keyed on the Web `controller.desiredSize` and the `pull()` callback.
 * This prevents a fast Node producer from buffering unboundedly when the
 * consumer is slow (relevant for both file streaming and long-lived child
 * stdout pipes).
 *
 * Use this for ALL Node-Readable → Web-ReadableStream conversions.
 * Never use `Readable.toWeb()` directly.
 */
export function toWebReadable(stream: Readable): ReadableStream<Uint8Array> {
  let destroyed = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stream.on("data", (chunk: Buffer | string) => {
          if (destroyed) return;
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          try {
            controller.enqueue(
              new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
            );
            // Apply backpressure: pause the source when the internal queue is full.
            if ((controller.desiredSize ?? 1) <= 0) {
              stream.pause();
            }
          } catch {
            destroyed = true;
            stream.destroy();
          }
        });
        stream.on("end", () => {
          if (destroyed) return;
          try { controller.close(); } catch { /* already closed */ }
        });
        stream.on("error", (err) => {
          if (destroyed) return;
          destroyed = true;
          try { controller.error(err); } catch { /* already closed */ }
        });
      },
      pull() {
        // Resume the Node stream when the consumer is ready for more data.
        if (!destroyed) {
          stream.resume();
        }
      },
      cancel() {
        destroyed = true;
        stream.destroy();
      },
    },
    // Default HWM of 1 chunk so backpressure kicks in promptly.
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
}
