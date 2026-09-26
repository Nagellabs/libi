// __tests__/unit/templates/cloud/asset-stream.test.ts
//
// D5–D6 review follow-up: a public template's link-only audio/video plays
// inline through libi's own route. The fetch behind it is an SSRF surface:
// these tests drive `openAssetStream` with a fake DNS and a fake `https.request`
// (no network), and check every refusal the owner asked for — private
// addresses, a redirect to one, non-https, the wrong content type — plus the
// pinned connection, the redirect cap, the byte cap and Range forwarding.
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setAssetStreamDepsForTests,
  ASSET_STREAM_MAX_BYTES,
  ASSET_STREAM_MAX_REDIRECTS,
  AssetStreamRefusal,
  forwardableRange,
  hostOf,
  isPublicAddress,
  openAssetStream,
} from "@/lib/templates/cloud/asset-stream";

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | string | Readable };
type Call = { url: string; headers: Record<string, string>; lookup: (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void };

/** A fake network: `dnsTable` answers lookups, `replies` answers each URL (by href). */
function fakeNet(dnsTable: Record<string, string[]>, replies: Record<string, Reply>) {
  const calls: Call[] = [];
  __setAssetStreamDepsForTests({
    lookup: async (host) => {
      const a = dnsTable[host];
      if (!a) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    request: ((url: URL, opts: { headers: Record<string, string>; lookup: Call["lookup"] }) => {
      calls.push({ url: url.href, headers: opts.headers, lookup: opts.lookup });
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
      req.destroy = (e?: Error) => void (e && req.emit("error", e));
      req.end = () =>
        setImmediate(() => {
          const r = replies[url.href];
          if (!r) return req.emit("error", new Error("ECONNREFUSED"));
          const body = r.body instanceof Readable ? r.body : Readable.from(r.body === undefined ? [] : [Buffer.from(r.body)]);
          const res = Object.assign(body, { statusCode: r.status, headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
          req.emit("response", res);
        });
      return req;
    }) as never,
  });
  return calls;
}

const open = (url: string, range?: string) => openAssetStream(url, { range, signal: new AbortController().signal });
async function refusal(p: Promise<unknown>): Promise<AssetStreamRefusal> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AssetStreamRefusal);
    return err as AssetStreamRefusal;
  }
  throw new Error("expected a refusal");
}
const text = async (r: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString();
};

afterEach(() => __setAssetStreamDepsForTests(null));

describe("isPublicAddress", () => {
  it("refuses private, loopback, link-local, metadata, CGNAT, multicast and reserved addresses, in every IPv6 disguise", () => {
    for (const ip of [
      "10.1.2.3", "127.0.0.1", "127.8.8.8", "0.0.0.0", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
      "192.0.2.10", "198.51.100.1", "203.0.113.9", "224.0.0.1", "255.255.255.255", "240.0.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
      "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1", "[::1]", "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
  it("admits global unicast", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("openAssetStream — refusals", () => {
  it("refuses a URL the install would: not https, an IP literal, localhost, credentials — before any lookup", async () => {
    const calls = fakeNet({}, {});
    for (const url of ["http://media.example.com/a.mp4", "https://192.168.1.1/a.mp4", "https://[::1]/a.mp4", "https://localhost/a.mp4", "https://box.local/a.mp4", "https://u:p@media.example.com/a.mp4", "ftp://media.example.com/a.mp4"]) {
      expect((await refusal(open(url))).code, url).toBe("invalid_url");
    }
    expect(calls).toEqual([]);
  });

  it("refuses a public-looking name that resolves to a private address — any of its answers", async () => {
    const calls = fakeNet({ "evil.example.com": ["93.184.216.34", "10.0.0.5"], "meta.example.com": ["169.254.169.254"], "six.example.com": ["::ffff:127.0.0.1"] }, {});
    for (const host of ["evil.example.com", "meta.example.com", "six.example.com"]) {
      expect((await refusal(open(`https://${host}/clip.mp4`))).code, host).toBe("private_address");
    }
    expect(calls).toEqual([]);
  });

  it("refuses a redirect to a private address, re-checking every hop", async () => {
    const calls = fakeNet(
      { "media.example.com": ["93.184.216.34"], "inside.example.com": ["192.168.0.10"] },
      { "https://media.example.com/clip.mp4": { status: 302, headers: { location: "https://inside.example.com/admin" } } },
    );
    expect((await refusal(open("https://media.example.com/clip.mp4"))).code).toBe("private_address");
    expect(calls.map((c) => c.url)).toEqual(["https://media.example.com/clip.mp4"]);
  });

  it("refuses a redirect to http, or to an IP literal", async () => {
    fakeNet(
      { "media.example.com": ["93.184.216.34"] },
      {
        "https://media.example.com/a.mp4": { status: 301, headers: { location: "http://media.example.com/a.mp4" } },
        "https://media.example.com/b.mp4": { status: 302, headers: { location: "https://127.0.0.1/b.mp4" } },
      },
    );
    expect((await refusal(open("https://media.example.com/a.mp4"))).code).toBe("invalid_url");
    expect((await refusal(open("https://media.example.com/b.mp4"))).code).toBe("invalid_url");
  });

  it(`follows at most ${ASSET_STREAM_MAX_REDIRECTS} redirects`, async () => {
    const replies: Record<string, Reply> = {};
    for (let i = 0; i < 10; i++) replies[`https://media.example.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const calls = fakeNet({ "media.example.com": ["93.184.216.34"] }, replies);
    expect((await refusal(open("https://media.example.com/0"))).code).toBe("too_many_redirects");
    expect(calls).toHaveLength(ASSET_STREAM_MAX_REDIRECTS + 1);
  });

  it("refuses anything but audio/* or video/*: an HTML page, JSON, an image, a missing type", async () => {
    const replies: Record<string, Reply> = {};
    for (const [i, type] of ["text/html", "application/json", "image/png", ""].entries()) replies[`https://media.example.com/${i}`] = { status: 200, headers: type ? { "content-type": type } : {}, body: "x" };
    fakeNet({ "media.example.com": ["93.184.216.34"] }, replies);
    for (let i = 0; i < 4; i++) expect((await refusal(open(`https://media.example.com/${i}`))).code).toBe("wrong_type");
  });

  it("refuses an upstream error status, and a declared length over the cap", async () => {
    fakeNet(
      { "media.example.com": ["93.184.216.34"] },
      {
        "https://media.example.com/gone.mp4": { status: 404, headers: { "content-type": "text/html" } },
        "https://media.example.com/huge.mp4": { status: 200, headers: { "content-type": "video/mp4", "content-length": String(ASSET_STREAM_MAX_BYTES + 1) } },
      },
    );
    const gone = await refusal(open("https://media.example.com/gone.mp4"));
    expect([gone.code, gone.upstreamStatus]).toEqual(["upstream_status", 404]);
    expect((await refusal(open("https://media.example.com/huge.mp4"))).code).toBe("too_large");
  });

  it("a host that can't be resolved, or can't be reached, is refused in libi's words", async () => {
    fakeNet({ "down.example.com": ["93.184.216.34"] }, {});
    expect((await refusal(open("https://nowhere.example.com/a.mp4"))).code).toBe("dns_failed");
    expect((await refusal(open("https://down.example.com/a.mp4"))).code).toBe("unreachable");
  });

  it("a body that runs past the cap is cut", async () => {
    const body = new PassThrough();
    fakeNet({ "media.example.com": ["93.184.216.34"] }, { "https://media.example.com/a.mp4": { status: 200, headers: { "content-type": "video/mp4" }, body } });
    const s = await open("https://media.example.com/a.mp4");
    const errored = new Promise<unknown>((resolve) => s.body.on("error", resolve));
    s.body.resume();
    const chunk = Buffer.alloc(16 * 1024 * 1024);
    for (let i = 0; i < 14; i++) body.write(chunk);
    expect(((await errored) as AssetStreamRefusal).code).toBe("too_large");
  });
});

describe("openAssetStream — a good stream", () => {
  it("streams audio/video from the address it checked, forwarding only a single byte Range, and passes on only the media headers", async () => {
    const calls = fakeNet(
      { "media.example.com": ["93.184.216.34"], "cdn.example.net": ["2606:4700:4700::1111"] },
      {
        "https://media.example.com/clip.mp4?sig=secret": { status: 302, headers: { location: "https://cdn.example.net/x/clip.mp4" } },
        "https://cdn.example.net/x/clip.mp4": {
          status: 206,
          headers: { "content-type": "Video/MP4; codecs=avc1", "content-length": "5", "content-range": "bytes 0-4/100", "accept-ranges": "bytes", "set-cookie": "a=b", "x-evil": "1" },
          body: "hello",
        },
      },
    );
    const s = await open("https://media.example.com/clip.mp4?sig=secret", "bytes=0-4");
    expect(s.status).toBe(206);
    expect(s.headers).toEqual({ "content-type": "video/mp4", "content-length": "5", "content-range": "bytes 0-4/100", "accept-ranges": "bytes" });
    expect(s.host).toBe("cdn.example.net");
    expect(await text(s.body)).toBe("hello");
    expect(calls.map((c) => c.headers.range)).toEqual(["bytes=0-4", "bytes=0-4"]);
    expect(calls.every((c) => !("cookie" in c.headers))).toBe(true);
    // The connection is pinned to the checked address: whatever DNS says at connect time.
    const pinned = await new Promise<unknown[]>((resolve) => calls[1].lookup("cdn.example.net", { all: true }, (...a) => resolve(a)));
    expect(pinned).toEqual([null, [{ address: "2606:4700:4700::1111", family: 6 }]]);
    const single = await new Promise<unknown[]>((resolve) => calls[0].lookup("media.example.com", {}, (...a) => resolve(a)));
    expect(single).toEqual([null, "93.184.216.34", 4]);
  });

  it("forwardableRange: one byte range only", () => {
    expect(forwardableRange("bytes=0-")).toBe("bytes=0-");
    expect(forwardableRange("bytes=100-199")).toBe("bytes=100-199");
    expect(forwardableRange("bytes=-500")).toBe("bytes=-500");
    for (const r of [null, "", "bytes=-", "bytes=0-1,5-9", "items=0-1", "bytes=0-1\r\nx: y"]) expect(forwardableRange(r)).toBeNull();
  });

  it("hostOf logs a host, never a path or query", () => {
    expect(hostOf("https://media.example.com/private/clip.mp4?token=abc")).toBe("media.example.com");
    expect(hostOf("::")).toBe("(unparseable)");
  });
});

/**
 * A REAL socket server that never stops sending: after its headers it writes
 * 64 KB chunks for as long as the connection lives, counting what it got out.
 * libi's requests reach it through a `request` that rewrites the (https,
 * public) URL to this loopback server — the SSRF checks run on the original.
 */
async function endlessServer(
  routes: Record<string, { status: number; headers: Record<string, string>; endless: boolean; body?: string; dripMs?: number }>,
  extra: Parameters<typeof __setAssetStreamDepsForTests>[0] = {},
) {
  const stats: Record<string, { written: number; closedAt: number | null }> = {};
  const server = http.createServer((req, res) => {
    const r = routes[req.url ?? ""];
    if (!r) return void res.writeHead(404).end();
    const st: { written: number; closedAt: number | null } = (stats[req.url!] = { written: 0, closedAt: null });
    res.writeHead(r.status, r.headers);
    req.socket.on("close", () => (st.closedAt = Date.now()));
    if (!r.endless) return void res.end(r.body ?? "");
    const chunk = Buffer.alloc(r.dripMs ? 16 : 64 * 1024, 7);
    const pump = () => {
      if (req.socket.destroyed) return;
      res.write(chunk, (err) => {
        if (err) return;
        st.written += chunk.length;
        if (r.dripMs) setTimeout(pump, r.dripMs);
        else setImmediate(pump);
      });
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  __setAssetStreamDepsForTests({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: ((url: URL, opts: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) =>
      http.request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...opts, lookup: undefined }, cb)) as never,
    ...extra,
  });
  return { stats, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

describe("openAssetStream — a refused upstream is closed, never drained (fix-round review N1)", () => {
  /** Half a second after a refusal, the upstream socket must be closed and have carried only a bounded amount. */
  const BOUND = 16 * 1024 * 1024;

  it("closes the socket of every refused response — wrong type, too large, an error status — and of a redirect, with the host still sending", async () => {
    const endless = { endless: true };
    const net = await endlessServer({
      "/html": { status: 200, headers: { "content-type": "text/html" }, ...endless },
      "/huge": { status: 200, headers: { "content-type": "video/mp4", "content-length": "50000000000" }, ...endless },
      "/e404": { status: 404, headers: { "content-type": "text/html" }, ...endless },
      "/redir": { status: 302, headers: { location: "/ok.mp4", "content-type": "text/html" }, ...endless },
      "/ok.mp4": { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" }, endless: false, body: "hello" },
    });
    try {
      for (const [p, code] of [["/html", "wrong_type"], ["/huge", "too_large"], ["/e404", "upstream_status"]] as const) {
        expect((await refusal(open(`https://media.example.com${p}`))).code, p).toBe(code);
      }
      const ok = await open("https://media.example.com/redir");
      expect(await text(ok.body)).toBe("hello");
      await new Promise((r) => setTimeout(r, 500));
      for (const p of ["/html", "/huge", "/e404", "/redir"]) {
        expect(net.stats[p].closedAt, `${p} socket still open`).not.toBeNull();
        expect(net.stats[p].written, `${p} kept downloading`).toBeLessThan(BOUND);
      }
    } finally {
      await net.close();
    }
  });

  it("a body that keeps arriving past the overall deadline is cut, and its socket closed (review N7)", async () => {
    const net = await endlessServer({ "/drip.mp4": { status: 200, headers: { "content-type": "video/mp4" }, endless: true, dripMs: 20 } }, { maxDurationMs: 300 });
    try {
      const s = await open("https://media.example.com/drip.mp4");
      expect(s.status).toBe(200);
      const failed = new Promise<unknown>((resolve) => s.body.on("error", resolve));
      s.body.resume(); // a steady drip: never stalls long enough for the idle deadline, never reaches the cap
      expect(((await failed) as AssetStreamRefusal).code).toBe("timeout");
      await new Promise((r) => setTimeout(r, 200));
      expect(net.stats["/drip.mp4"].closedAt).not.toBeNull();
    } finally {
      await net.close();
    }
  });
});

describe("openAssetStream — the DNS lookup has a deadline (final review F3)", () => {
  it("a lookup that never answers is refused at the deadline, and nothing is requested", async () => {
    let requested = false;
    __setAssetStreamDepsForTests({
      lookup: () => new Promise(() => {}),
      request: (() => ((requested = true), new EventEmitter())) as never,
      dnsTimeoutMs: 50,
    });
    const at = Date.now();
    const r = await refusal(open("https://media.example.com/a.mp4"));
    expect(r.code).toBe("timeout");
    expect(Date.now() - at).toBeLessThan(1000);
    expect(requested).toBe(false);
  });

  it("a hanging lookup ends as soon as the page's request is cancelled", async () => {
    __setAssetStreamDepsForTests({ lookup: () => new Promise(() => {}), dnsTimeoutMs: 60_000 });
    const ac = new AbortController();
    const p = openAssetStream("https://media.example.com/a.mp4", { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const at = Date.now();
    expect((await refusal(p)).code).toBe("unreachable");
    expect(Date.now() - at).toBeLessThan(1000);
  });
});
