import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));
const open = vi.hoisted(() => vi.fn());
vi.mock("@/lib/templates/cloud/asset-stream", async (orig) => ({ ...(await orig<typeof import("@/lib/templates/cloud/asset-stream")>()), openAssetStream: open }));

import { GET } from "@/app/api/social/music/preview/route";
import { AssetStreamRefusal, __setAssetStreamDepsForTests } from "@/lib/templates/cloud/asset-stream";

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3461/api/social/music/preview?url=${encodeURIComponent(url)}`, { headers: { host: "127.0.0.1:3461", ...headers } });
const PAGE = { "sec-fetch-site": "same-origin" };
beforeEach(() => {
  open.mockReset();
  for (const spy of Object.values(logSpies)) spy.mockClear();
});
afterEach(() => __setAssetStreamDepsForTests(null));

describe("GET /api/social/music/preview", () => {
  it("streams an allow-listed preview through the guarded fetch", async () => {
    open.mockResolvedValue({ status: 200, headers: { "content-type": "audio/mpeg" }, body: Readable.from([Buffer.from("abc")]), host: "a.tiktokcdn.com" });
    const res = await GET(req("https://a.tiktokcdn.com/obj/x", PAGE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(open).toHaveBeenCalledWith("https://a.tiktokcdn.com/obj/x", expect.objectContaining({ range: null, allowUrl: expect.any(Function) }));
    const { allowUrl } = open.mock.calls[0][1] as { allowUrl: (u: URL) => boolean };
    expect(allowUrl(new URL("https://b.cdninstagram.com/a.mp4"))).toBe(true);
    expect(allowUrl(new URL("https://example.com/a.mp4"))).toBe(false);
  });
  it("refuses a host that is not a platform CDN, without fetching", async () => {
    const res = await GET(req("https://example.com/a.mp3", PAGE));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("host_not_allowed");
    expect(open).not.toHaveBeenCalled();
    expect(logSpies.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "social-music", op: "preview_refused", host: "example.com" }), expect.any(String));
  });
  it("refuses a URL over the length cap, even on an allowed host, without fetching", async () => {
    const res = await GET(req(`https://a.tiktokcdn.com/${"x".repeat(2048)}`, PAGE));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("host_not_allowed");
    expect(open).not.toHaveBeenCalled();
  });
  it("refuses another site's page", async () => {
    expect((await GET(req("https://a.tiktokcdn.com/x", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });
  it("maps the guarded fetch's refusals to statuses, logged under social-music", async () => {
    for (const [code, status] of [["private_address", 403], ["invalid_url", 403], ["wrong_type", 415], ["too_large", 413], ["timeout", 504], ["upstream_status", 502]] as const) {
      open.mockRejectedValueOnce(new AssetStreamRefusal(code, "nope"));
      const res = await GET(req("https://a.tiktokcdn.com/x", PAGE));
      expect(res.status, code).toBe(status);
      expect((await res.json()).code, code).toBe(code);
      expect(logSpies.warn).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "social-music", op: "preview_refused", reason: code }), expect.any(String));
    }
  });
  it("an unexpected failure is a 500, logged as preview_failed", async () => {
    open.mockRejectedValueOnce(new TypeError("boom"));
    const res = await GET(req("https://a.tiktokcdn.com/x", PAGE));
    expect(res.status).toBe(500);
    expect(logSpies.error).toHaveBeenCalledWith(expect.objectContaining({ tag: "social-music", op: "preview_failed" }), expect.any(String));
  });

  it("a platform CDN that redirects off the allow-list is refused at the redirect, never fetched", async () => {
    const real = await vi.importActual<typeof import("@/lib/templates/cloud/asset-stream")>("@/lib/templates/cloud/asset-stream");
    open.mockImplementation(real.openAssetStream);
    const fetched: string[] = [];
    __setAssetStreamDepsForTests({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: ((url: URL) => {
        fetched.push(url.href);
        const r = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
        r.destroy = () => {};
        r.end = () =>
          setImmediate(() => {
            const res = Object.assign(Readable.from([]), {
              statusCode: url.hostname === "a.tiktokcdn.com" ? 302 : 200,
              headers: url.hostname === "a.tiktokcdn.com" ? { location: "https://media.example.com/y.mp3" } : { "content-type": "audio/mpeg" },
            });
            r.emit("response", res);
          });
        return r;
      }) as never,
    });
    const res = await GET(req("https://a.tiktokcdn.com/x", PAGE));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("invalid_url");
    expect(fetched).toEqual(["https://a.tiktokcdn.com/x"]);
  });

  it("kind=artwork asks the stream for an image; a preview asks for audio/video", async () => {
    open.mockResolvedValue({ status: 200, headers: { "content-type": "image/jpeg" }, body: Readable.from([Buffer.from("abc")]), host: "p16-sg.tiktokcdn.com" });
    await GET(new Request("http://127.0.0.1:3461/api/social/music/preview?kind=artwork&url=" + encodeURIComponent("https://p16-sg.tiktokcdn.com/a.jpg"), { headers: { host: "127.0.0.1:3461" } }));
    expect(open).toHaveBeenLastCalledWith("https://p16-sg.tiktokcdn.com/a.jpg", expect.objectContaining({ kinds: ["image"], range: null }));
    await GET(new Request("http://127.0.0.1:3461/api/social/music/preview?url=" + encodeURIComponent("https://p16-sg.tiktokcdn.com/a.mp3"), { headers: { host: "127.0.0.1:3461" } }));
    expect(open.mock.calls.at(-1)?.[1]).not.toHaveProperty("kinds");
  });
});
