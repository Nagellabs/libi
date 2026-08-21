/**
 * Real sockets, real bytes. The hash check in particular must be proven to
 * run BEFORE anything is stored — a mismatch that leaves a file on disk and a
 * row in the DB is worse than no check at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { fetchAndStoreRemoteFile, fetchRemoteBuffer } from "@/lib/net/fetch-and-store";
import { assertDevLoopbackOrPublicHttpUrl } from "@/lib/net/url-guard";

let storageRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(path.join(storageRoot, "storage"));
  },
}));

const PIECE_ID = "p_fas";
/** A tiny, real payload. `.png` keeps storeFile off the ffprobe path. */
const PAYLOAD = Buffer.from("libi-onboarding-fixture-bytes\n".repeat(16), "utf8");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const BIG_PAYLOAD = Buffer.alloc(64 * 1024, 7);

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/logo-mark.png") {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(PAYLOAD.byteLength),
      });
      res.end(PAYLOAD);
      return;
    }
    if (url.pathname === "/big.png") {
      // Chunked on purpose — two writes and no content-length, so the server
      // declares nothing. What stops this download has to be the running byte
      // cap, not the advisory header pre-check.
      res.writeHead(200, { "content-type": "image/png" });
      res.write(BIG_PAYLOAD.subarray(0, BIG_PAYLOAD.byteLength / 2));
      res.end(BIG_PAYLOAD.subarray(BIG_PAYLOAD.byteLength / 2));
      return;
    }
    if (url.pathname === "/opaque.png" || url.pathname === "/opaque.unknownext") {
      // A bucket that declares nothing useful — the case that files a download
      // as type "other" and skips the ffprobe pass.
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(PAYLOAD.byteLength),
      });
      res.end(PAYLOAD);
      return;
    }
    if (url.pathname === "/opaque-params.png") {
      // Same non-answer, dressed with a parameter.
      res.writeHead(200, {
        "content-type": "application/octet-stream; charset=binary",
        "content-length": String(PAYLOAD.byteLength),
      });
      res.end(PAYLOAD);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-fas-"));
  process.env.LIBI_HOME = storageRoot;
  fs.mkdirSync(path.join(storageRoot, "storage", PIECE_ID), { recursive: true });
  const db = createTestDb();
  seedPiece(db as never, { id: PIECE_ID, name: "fas" });
  vi.mocked(getDb).mockReturnValue(db as never);
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(storageRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

function storedRows() {
  return vi.mocked(getDb)().select().from(files).all();
}

function storedFilenames(): string[] {
  const dir = path.join(storageRoot, "storage", PIECE_ID);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/**
 * The content-type decision belongs HERE, not at each caller. Both callers
 * (`remote_fetch` and the onboarding build) get it from one place, so a bucket
 * that declares `application/octet-stream` can only be rediscovered once.
 */
describe("fetchRemoteBuffer: the content-type seam", () => {
  it("prefers an informative header", async () => {
    const r = await fetchRemoteBuffer({
      url: `${base}/logo-mark.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
    });
    expect(r.contentType).toBe("image/png");
  });

  it("treats application/octet-stream as ABSENT, not as an answer", async () => {
    const r = await fetchRemoteBuffer({
      url: `${base}/opaque.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
    });
    expect(r.contentType).toBe("image/png");
  });

  it("ignores parameters on the octet-stream non-answer", async () => {
    const r = await fetchRemoteBuffer({
      url: `${base}/opaque-params.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
    });
    expect(r.contentType).toBe("image/png");
  });

  it("returns null when neither the header nor the extension is informative", async () => {
    const r = await fetchRemoteBuffer({
      url: `${base}/opaque.unknownext`,
      guard: assertDevLoopbackOrPublicHttpUrl,
    });
    expect(r.contentType).toBeNull();
  });
});

describe("fetchAndStoreRemoteFile", () => {
  it("downloads over a real socket and registers a piece file", async () => {
    const result = await fetchAndStoreRemoteFile({
      url: `${base}/logo-mark.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
    });

    expect(result.fileId).toBeTruthy();
    expect(result.filename).toBe("logo-mark.png");
    expect(result.bytes).toBe(PAYLOAD.byteLength);

    const rows = storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.fileId);
    expect(rows[0].contentType).toBe("image/png");
    expect(
      fs.readFileSync(path.join(storageRoot, "storage", PIECE_ID, "logo-mark.png")),
    ).toEqual(PAYLOAD);
  });

  it("an octet-stream header does not defeat the extension fallback", async () => {
    // No caller override at all — this is the `remote_fetch` shape. A bucket
    // that serves everything as `application/octet-stream` used to file the
    // download as type "other", skipping the ffprobe pass: no duration, no
    // dimensions, no proxy. Fixed at the seam, so no caller has to know.
    await fetchAndStoreRemoteFile({
      url: `${base}/opaque.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
    });
    const [row] = storedRows();
    expect(row.contentType).toBe("image/png");
    expect(row.type).toBe("image");
  });

  it("still lands as type 'other' when neither header nor extension says anything", async () => {
    await fetchAndStoreRemoteFile({
      url: `${base}/opaque.unknownext`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
    });
    const [row] = storedRows();
    expect(row.contentType).toBeNull();
    expect(row.type).toBe("other");
  });

  it("a caller's declared content type overrides the response header", async () => {
    // For a sha-pinned download the media type is a fact of the CALLER's
    // definition. Landing as "other" would skip probing — no dimensions, and
    // a tracked overlay has nothing to map its source-pixel boxes with.
    await fetchAndStoreRemoteFile({
      url: `${base}/opaque.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
      expectSha256: PAYLOAD_SHA,
      contentType: "image/png",
    });
    const [row] = storedRows();
    expect(row.contentType).toBe("image/png");
    expect(row.type).toBe("image");
  });

  it("accepts a matching expectSha256", async () => {
    const result = await fetchAndStoreRemoteFile({
      url: `${base}/logo-mark.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
      expectSha256: PAYLOAD_SHA,
    });
    expect(result.bytes).toBe(PAYLOAD.byteLength);
    expect(storedRows()).toHaveLength(1);
  });

  it("returns the name the file was ACTUALLY stored under, not the one requested", async () => {
    const first = await fetchAndStoreRemoteFile({
      url: `${base}/logo-mark.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
    });
    // Same name again: storeFile dedupes within the piece scope.
    const second = await fetchAndStoreRemoteFile({
      url: `${base}/logo-mark.png`,
      guard: assertDevLoopbackOrPublicHttpUrl,
      pieceId: PIECE_ID,
    });

    expect(first.filename).toBe("logo-mark.png");
    expect(second.filename).toBe("logo-mark (1).png");
    // The returned name must be usable to find the bytes — that is the whole
    // point, and a re-run of the onboarding build is exactly this caller.
    for (const r of [first, second]) {
      expect(
        fs.existsSync(path.join(storageRoot, "storage", PIECE_ID, r.filename)),
      ).toBe(true);
    }
    expect(storedRows().map((r) => r.filename).sort()).toEqual([
      "logo-mark (1).png",
      "logo-mark.png",
    ]);
  });

  it("throws on a malformed expectSha256 instead of failing open", async () => {
    // "" is the dangerous one: a truthiness check would skip verification
    // entirely and store an unverified download.
    for (const bad of ["", "   ", "abc123", `${PAYLOAD_SHA}extra`]) {
      await expect(
        fetchAndStoreRemoteFile({
          url: `${base}/logo-mark.png`,
          guard: assertDevLoopbackOrPublicHttpUrl,
          pieceId: PIECE_ID,
          expectSha256: bad,
        }),
      ).rejects.toThrow(/invalid expectSha256/);
    }
    expect(storedRows()).toHaveLength(0);
    expect(storedFilenames()).toEqual([]);
  });

  it("rejects a wrong expectSha256 and stores NOTHING — no row, no bytes on disk", async () => {
    const wrong = "0".repeat(64);
    await expect(
      fetchAndStoreRemoteFile({
        url: `${base}/logo-mark.png`,
        guard: assertDevLoopbackOrPublicHttpUrl,
        pieceId: PIECE_ID,
        expectSha256: wrong,
      }),
    ).rejects.toThrow(/sha256 mismatch for logo-mark\.png/);

    // The whole point of hashing the buffer instead of the written file:
    // a failure leaves no cleanup to do.
    expect(storedRows()).toHaveLength(0);
    expect(storedFilenames()).toEqual([]);
  });

  it("aborts a body that exceeds maxBytes, storing nothing", async () => {
    await expect(
      fetchAndStoreRemoteFile({
        url: `${base}/big.png`,
        guard: assertDevLoopbackOrPublicHttpUrl,
        pieceId: PIECE_ID,
        maxBytes: 1024,
      }),
      // "exceeds" is the STREAMING cap's wording — proving the body was cut
      // off mid-flight rather than rejected from a declared Content-Length.
    ).rejects.toThrow(/file too large: exceeds 1024 bytes/);

    expect(storedRows()).toHaveLength(0);
    expect(storedFilenames()).toEqual([]);
  });

  it("throws on a 404", async () => {
    await expect(
      fetchAndStoreRemoteFile({
        url: `${base}/missing.png`,
        guard: assertDevLoopbackOrPublicHttpUrl,
        pieceId: PIECE_ID,
      }),
    ).rejects.toThrow(/http 404/);

    expect(storedRows()).toHaveLength(0);
    expect(storedFilenames()).toEqual([]);
  });

  it("still refuses a non-loopback private address through the dev guard", async () => {
    // The relaxed guard permits loopback on any port — and nothing else. A
    // metadata address must still be rejected before a socket is opened.
    await expect(
      fetchAndStoreRemoteFile({
        url: "http://169.254.169.254/latest/meta-data/",
        guard: assertDevLoopbackOrPublicHttpUrl,
        pieceId: PIECE_ID,
      }),
    ).rejects.toThrow(/blocked private address/);
  });
});
