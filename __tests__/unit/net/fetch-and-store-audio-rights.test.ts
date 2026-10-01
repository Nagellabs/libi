/** fetchAndStoreRemoteFile hands storeFile a copyrighted stamp by default,
 *  and the caller's own when it passes one. storeFile is mocked; a real
 *  loopback server serves the bytes (same guard the integration test uses). */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const storeFile = vi.hoisted(() => vi.fn(async (a: { filename: string }) => ({ id: "f1", filename: a.filename })));
vi.mock("@/mcp/tools/file-tools", async (orig) => ({ ...(await orig<typeof import("@/mcp/tools/file-tools")>()), storeFile }));

import { fetchAndStoreRemoteFile } from "@/lib/net/fetch-and-store";
import { assertDevLoopbackOrPublicHttpUrl } from "@/lib/net/url-guard";
import { ownedByProvenance } from "@/lib/audio-rights/stamp";

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": "3" });
    res.end("abc");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("fetchAndStoreRemoteFile audio rights", () => {
  it("stamps copyrighted with the fetched url by default", async () => {
    await fetchAndStoreRemoteFile({ url: `${base}/song.mp3`, guard: assertDevLoopbackOrPublicHttpUrl, pieceId: null });
    expect(storeFile.mock.calls.at(-1)![0]).toMatchObject({
      audioRights: { class: "copyrighted", source: { url: `${base}/song.mp3` }, decidedBy: "provenance" },
    });
  });

  it("passes the caller's stamp through", async () => {
    const owned = ownedByProvenance(new Date("2026-09-27T00:00:00Z"));
    await fetchAndStoreRemoteFile({ url: `${base}/song.mp3`, guard: assertDevLoopbackOrPublicHttpUrl, pieceId: null, audioRights: owned });
    expect(storeFile.mock.calls.at(-1)![0]).toMatchObject({ audioRights: owned });
  });
});
