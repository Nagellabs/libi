import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  directoryBytes,
  trackDirectoryBytes,
} from "@/lib/jobs/dir-download-progress";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dirbytes-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, bytes: number): void {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
}

describe("directoryBytes", () => {
  it("sums files recursively", async () => {
    write("config.json", 100);
    write("transformer/model.safetensors", 5000);
    write("nested/deep/blob", 25);
    expect(await directoryBytes(tmp)).toBe(5125);
  });

  it("returns 0 for a directory that does not exist yet", async () => {
    // A download reports progress before its destination is created; throwing
    // here would fail the job over a missing folder.
    expect(await directoryBytes(path.join(tmp, "not-created"))).toBe(0);
  });

  it("counts in-flight partials under .cache", async () => {
    // huggingface_hub streams into `.cache/huggingface/download/` and moves the
    // finished file into place. Ignoring that subtree would show 0 bytes for the
    // entire 24 minutes the 6.6 GB transformer is transferring.
    write(".cache/huggingface/download/blob.incomplete", 4096);
    expect(await directoryBytes(tmp)).toBe(4096);
  });

  it("does not double-count a symlinked blob", async () => {
    write("real/model.bin", 800);
    fs.symlinkSync(path.join(tmp, "real/model.bin"), path.join(tmp, "link.bin"));
    expect(await directoryBytes(tmp)).toBe(800);
  });
});

describe("trackDirectoryBytes", () => {
  it("reports a clamped, monotonic byte count", async () => {
    const seen: number[] = [];
    write("a", 500);
    const p = trackDirectoryBytes({
      dir: tmp,
      totalBytes: 1000,
      intervalMs: 5,
      onBytes: (done) => seen.push(done),
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toBe(500);

    write("b", 400);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(900));

    // Overshoot clamps to the pinned total rather than rendering >100%.
    write("c", 5000);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(1000));
    p.stop();

    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it("never reports a decrease when files move out from under it", async () => {
    // HF moves a completed blob from .cache into place; a naive walk can catch
    // the instant where neither copy is fully visible. A dip reads as negative
    // progress and poisons the rolling ETA rate.
    const seen: number[] = [];
    write("big", 900);
    const p = trackDirectoryBytes({
      dir: tmp,
      totalBytes: 10_000,
      intervalMs: 5,
      onBytes: (done) => seen.push(done),
    });
    await vi.waitFor(() => expect(seen.at(-1)).toBe(900));

    fs.rmSync(path.join(tmp, "big"));
    await new Promise((r) => setTimeout(r, 40));
    p.stop();

    expect(Math.min(...seen)).toBe(900);
    expect(seen.at(-1)).toBe(900);
  });

  it("stops reporting after stop()", async () => {
    write("a", 10);
    const seen: number[] = [];
    const p = trackDirectoryBytes({
      dir: tmp,
      totalBytes: 10_000,
      intervalMs: 5,
      onBytes: (done) => seen.push(done),
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    p.stop();
    const countAtStop = seen.length;

    write("b", 5000);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.length).toBe(countAtStop);
  });

  it("coalesces a poke() that lands while a walk is already running", async () => {
    // The walk in flight began before this write, so it cannot see it. Dropping
    // the request (the first cut of this helper did) loses the progress until the
    // next interval — and with a 1.5s interval and a poke on every completed
    // file, that silently discarded most of the pokes.
    write("a", 100);
    const seen: number[] = [];
    const p = trackDirectoryBytes({
      dir: tmp,
      intervalMs: 60_000,
      totalBytes: 10_000,
      onBytes: (done) => seen.push(done),
    });
    // Poke immediately, without awaiting — the constructor's own measure is
    // still in flight at this point.
    write("b", 400);
    p.poke();
    await vi.waitFor(() => expect(seen.at(-1)).toBe(500));
    p.stop();
  });

  it("poke() reports without waiting for the interval", async () => {
    write("a", 700);
    const seen: number[] = [];
    const p = trackDirectoryBytes({
      dir: tmp,
      // Long enough that a passing test cannot be the timer firing.
      intervalMs: 60_000,
      totalBytes: 10_000,
      onBytes: (done) => seen.push(done),
    });
    await vi.waitFor(() => expect(seen.at(-1)).toBe(700));

    write("b", 300);
    p.poke();
    await vi.waitFor(() => expect(seen.at(-1)).toBe(1000));
    p.stop();
  });
});
