/**
 * An Opus Matroska file's trims (`readOpusDiscards`, a whole-stream ffprobe
 * packet read) that time out are "unknown", not "none" (review round 5, M5):
 * the /timing answer then carries no trims and is NOT cached, so the next
 * request reads them again. It used to cache `[]` as a real answer, and a
 * joined file lost its trims until the file changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const child = vi.hoisted(() => ({ impl: null as null | ((args: string[]) => { err?: Error & { killed?: boolean }; stdout?: string }) }));
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  const execFile = (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    const r = child.impl ? child.impl(args) : {};
    setImmediate(() => (r.err ? cb(r.err) : cb(null, { stdout: r.stdout ?? "", stderr: "" })));
  };
  // promisify(execFile) resolves with {stdout, stderr} through the custom symbol.
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string, args: string[], opts: unknown) =>
    new Promise((resolve, reject) => execFile(cmd, args, opts, (err, out) => (err ? reject(err) : resolve(out))));
  return { ...actual, execFile, default: { ...actual, execFile } };
});

import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { readOpusDiscards } from "@/lib/ffmpeg/probe";

/** ffprobe's -show_format/-show_streams answer for an Opus WebM. */
const OPUS_WEBM = JSON.stringify({
  format: { format_name: "matroska,webm", duration: "2.0", start_time: "0.000000" },
  streams: [{ index: 0, codec_type: "audio", codec_name: "opus", channels: 2, sample_rate: "48000", time_base: "1/1000", start_time: "0.000000", disposition: { default: 1 } }],
});

const timedOut = () => Object.assign(new Error("Command failed: ffprobe (timed out)"), { killed: true });

describe("Opus trims that can't be read", () => {
  let tmp: string;
  let packetRead: "timeout" | "ok";
  let packetReads: number;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-opus-trims-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    packetRead = "timeout";
    packetReads = 0;
    child.impl = (args) => {
      if (args.includes("-show_format")) return { stdout: OPUS_WEBM };
      if (args.includes("packet=pts_time:packet_side_data=discard_padding")) {
        packetReads++;
        return packetRead === "timeout" ? { err: timedOut() } : { stdout: "0.000000\n1.180000,312\n1.200000\n" };
      }
      return { stdout: "" }; // any other side read (track flags are read from the file itself)
    };
    const db = createTestDb();
    seedPiece(db, { id: "p1" });
    const dir = path.join(tmp, "storage", "p1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "joined.webm"), Buffer.alloc(64));
    db.insert(files).values({ id: "f1", pieceId: "p1", filename: "joined.webm", name: "joined.webm", description: "", type: "audio", storagePath: "p1/joined.webm" }).run();
  });
  afterEach(() => {
    child.impl = null;
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("readOpusDiscards tells a failed read from 'no trims'", async () => {
    expect(await readOpusDiscards("/x.webm", 0)).toEqual({ ok: false });
    packetRead = "ok";
    expect(await readOpusDiscards("/x.webm", 0)).toEqual({ ok: true, trims: [[1.18, 312]] });
    child.impl = () => ({ stdout: "0.000000\n0.020000\n" });
    expect(await readOpusDiscards("/x.webm", 0)).toEqual({ ok: true, trims: [] });
  });

  it("the first /timing answer has no trims and is not cached; the next reads them; then it is cached", async () => {
    const { GET } = await import("@/app/api/files/by-id/[fileId]/timing/route");
    const get = async () => (await (await GET(new Request("http://127.0.0.1/api/files/by-id/f1/timing"), { params: Promise.resolve({ fileId: "f1" }) })).json()) as { opusTrims: unknown; cacheable?: unknown };

    const first = await get();
    expect(first.opusTrims).toEqual([]);
    expect(first).not.toHaveProperty("cacheable"); // internal, never in the body
    packetRead = "ok";
    expect((await get()).opusTrims).toEqual([[1.18, 312]]);
    expect(packetReads).toBe(2);
    expect((await get()).opusTrims).toEqual([[1.18, 312]]);
    expect(packetReads).toBe(2); // a real answer is cached
  });

  it("two concurrent requests for one uncached file read its packets once", async () => {
    const { GET } = await import("@/app/api/files/by-id/[fileId]/timing/route");
    const get = async () => (await (await GET(new Request("http://127.0.0.1/api/files/by-id/f1/timing"), { params: Promise.resolve({ fileId: "f1" }) })).json()) as { opusTrims: unknown };

    packetRead = "ok"; // both concurrent requests would each read the packets if not deduped
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.opusTrims).toEqual([[1.18, 312]]);
    expect(b.opusTrims).toEqual([[1.18, 312]]);
    expect(packetReads).toBe(1); // shared one in-flight probe, not two
  });
});
