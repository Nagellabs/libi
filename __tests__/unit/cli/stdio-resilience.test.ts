/**
 * A dead stdout pipe must not be able to kill the server.
 *
 * The real failure (2026-08-04, 08-19, 08-20): the process owning our stdout
 * goes away, Next's dev request logger writes a line on the next request, the
 * write raises EPIPE, and an unhandled stream `error` becomes an
 * uncaughtException. `bin/libi.js` spawns the server with `stdio: "inherit"`,
 * so the shell survives while the server dies — the app looks hung, not
 * crashed.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  installStdioResilience,
  resetStdioResilienceForTests,
} from "@/lib/cli/stdio-resilience";

/** Emit a stream error the way Node does when a write fails. */
function emitStreamError(stream: NodeJS.WriteStream, code: string): void {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  stream.emit("error", err);
}

afterEach(() => {
  resetStdioResilienceForTests();
});

describe("installStdioResilience", () => {
  it("swallows EPIPE on stdout and stderr", () => {
    installStdioResilience();
    // Unhandled, these would be uncaughtExceptions that kill the process.
    expect(() => emitStreamError(process.stdout, "EPIPE")).not.toThrow();
    expect(() => emitStreamError(process.stderr, "EPIPE")).not.toThrow();
  });

  it("swallows ERR_STREAM_DESTROYED — the same situation after teardown", () => {
    installStdioResilience();
    expect(() => emitStreamError(process.stdout, "ERR_STREAM_DESTROYED")).not.toThrow();
  });

  it("re-throws any other stream error", () => {
    // A genuinely broken stdout is still worth crashing on — the guard must be
    // narrow, not a blanket swallow of everything the stream reports.
    installStdioResilience();
    expect(() => emitStreamError(process.stdout, "ENOSPC")).toThrow(/ENOSPC/);
  });

  it("is idempotent — a second install adds no second listener", () => {
    installStdioResilience();
    const afterFirst = process.stdout.listenerCount("error");
    installStdioResilience();
    expect(process.stdout.listenerCount("error")).toBe(afterFirst);
  });

  it("attaches a listener to both streams", () => {
    resetStdioResilienceForTests();
    expect(process.stdout.listenerCount("error")).toBe(0);
    installStdioResilience();
    expect(process.stdout.listenerCount("error")).toBeGreaterThan(0);
    expect(process.stderr.listenerCount("error")).toBeGreaterThan(0);
  });
});
