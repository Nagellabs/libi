/**
 * A public template's link-only audio or video, streamed through libi so it
 * can play inline on the template's page — without widening the app CSP's
 * `media-src` to arbitrary hosts (the page loads it from libi's own origin:
 * `/api/templates/cloud/asset-stream`).
 *
 * A server that fetches a URL a stranger wrote is an SSRF surface, so:
 *  - the URL must pass the install's own asset check (`hostedUrlProblem`:
 *    https, no credentials, a public host NAME — no IP literal, no
 *    localhost / .local / .internal) — on every hop, redirects included;
 *  - every hop's host is resolved first and refused when ANY address it
 *    resolves to is private, loopback, link-local, CGNAT, multicast,
 *    reserved, documentation, or a cloud metadata address
 *    (`isPublicAddress`), IPv4-mapped / NAT64 / 6to4 IPv6 forms included;
 *  - the connection goes to the address that was checked (a pinned
 *    `lookup`), so a second DNS answer can't swap in an internal one;
 *  - at most `ASSET_STREAM_MAX_REDIRECTS` redirects, each re-checked;
 *  - only a 200 or 206 whose Content-Type is `audio/*` or `video/*` is
 *    passed on; at most `ASSET_STREAM_MAX_BYTES` per response (a declared
 *    length over it is refused up front, a body that runs over is cut);
 *  - a deadline for each DNS lookup, for the response headers, for a
 *    stalled body and for the whole response;
 *  - a response that is refused (or a redirect) is CLOSED at once, never
 *    drained: its body is the host's to keep sending, not libi's to read.
 * Only the client's `Range` is forwarded (so seeking works) — never cookies
 * or any other header of the user's.
 *
 * Server-only. Node's `https`, `dns` and `net`.
 */
import dns from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform, type Readable } from "node:stream";
import { hostedUrlProblem } from "@/lib/templates/cloud/preflight";

export const ASSET_STREAM_MAX_REDIRECTS = 3;
/** Per response. A template's own example is capped far lower; this is for someone's hosted clip. */
export const ASSET_STREAM_MAX_BYTES = 200 * 1024 * 1024;
export const ASSET_STREAM_HEADERS_TIMEOUT_MS = 10_000;
/** A host name that won't resolve in this long is refused (final review F3): a black-holed nameserver would otherwise hold each hop for the system resolver's 20–30 s. */
export const ASSET_STREAM_DNS_TIMEOUT_MS = 5_000;
export const ASSET_STREAM_IDLE_TIMEOUT_MS = 30_000;
/** Per response, however steadily it trickles: a slow drip must not hold a socket open for ever. */
export const ASSET_STREAM_MAX_DURATION_MS = 15 * 60_000;

export type AssetStreamRefusalCode =
  | "invalid_url"
  | "private_address"
  | "dns_failed"
  | "too_many_redirects"
  | "wrong_type"
  | "too_large"
  | "upstream_status"
  | "timeout"
  | "unreachable";

export class AssetStreamRefusal extends Error {
  constructor(
    readonly code: AssetStreamRefusalCode,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "AssetStreamRefusal";
  }
}

// --- which addresses may be fetched ---------------------------------------------------------

const BLOCKED = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 (cloud metadata)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  BLOCKED.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  // No ::ffff:0:0/96 here: BlockList matches plain IPv4 against it, which would block every address.
  // IPv4-mapped forms are refused by `mappedIPv4` instead.
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local, incl. fd00:ec2::254 (cloud metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net6, prefix, "ipv6");
}

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`) carries, else null. */
function mappedIPv4(ip: string): string | null {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const rest = m[1];
  if (net.isIPv4(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True only for a global unicast address: anything private, local, reserved or special is false. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(bare)) return !BLOCKED.check(bare, "ipv4");
  if (!net.isIPv6(bare)) return false;
  const v4 = mappedIPv4(bare);
  if (v4 !== null) return false; // a mapped address is never fetched as such
  if (BLOCKED.check(bare, "ipv6")) return false;
  // Only 2000::/3 is global unicast.
  const first = parseInt(bare.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff;
}

// --- the fetch -------------------------------------------------------------------------------

export interface AssetStreamDeps {
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: typeof https.request;
  isAllowedAddress: (ip: string) => boolean;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  maxDurationMs: number;
  dnsTimeoutMs: number;
}

const DEFAULT_DEPS: AssetStreamDeps = {
  lookup: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  request: https.request,
  isAllowedAddress: isPublicAddress,
  headersTimeoutMs: ASSET_STREAM_HEADERS_TIMEOUT_MS,
  idleTimeoutMs: ASSET_STREAM_IDLE_TIMEOUT_MS,
  maxDurationMs: ASSET_STREAM_MAX_DURATION_MS,
  dnsTimeoutMs: ASSET_STREAM_DNS_TIMEOUT_MS,
};
let deps: AssetStreamDeps = DEFAULT_DEPS;

/** Tests (and the local-https screenshot harness) swap the network; `null` restores the real one. */
export function __setAssetStreamDepsForTests(over: Partial<AssetStreamDeps> | null): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

/** A `Range` header worth forwarding: one `bytes=` range, nothing else. */
export function forwardableRange(range: string | null): string | null {
  if (!range) return null;
  return /^bytes=\d{0,15}-\d{0,15}$/.test(range.trim()) && range.trim() !== "bytes=-" ? range.trim() : null;
}

export interface AssetStream {
  status: 200 | 206;
  /** Only these reach the page. */
  headers: { "content-type": string; "content-length"?: string; "content-range"?: string; "accept-ranges"?: string };
  body: Readable;
  /** The host that finally answered — for the log, never the URL. */
  host: string;
}

/** The host of a URL for a log line — never its path or query. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "(unparseable)";
  }
}

async function checkedAddress(hostname: string, signal: AbortSignal): Promise<{ address: string; family: number }> {
  let answers: Array<{ address: string; family: number }>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Raced against a deadline and the page's own request: a lookup that hangs holds nothing.
    answers = await Promise.race([
      deps.lookup(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AssetStreamRefusal("timeout", "The media's host name didn't resolve in time.")), deps.dnsTimeoutMs);
        onAbort = () => reject(new AssetStreamRefusal("unreachable", "The request was cancelled."));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (err) {
    if (err instanceof AssetStreamRefusal) throw err;
    throw new AssetStreamRefusal("dns_failed", "The media's host couldn't be found.");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (answers.length === 0) throw new AssetStreamRefusal("dns_failed", "The media's host couldn't be found.");
  // Refused if ANY answer is internal: a name that also points inside is not one to trust with the first.
  if (answers.some((a) => !deps.isAllowedAddress(a.address))) {
    throw new AssetStreamRefusal("private_address", "The media's host is a private or local address; libi doesn't fetch those.");
  }
  return answers[0];
}

function requestOnce(url: URL, pinned: { address: string; family: number }, range: string | null, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = deps.request(
      url,
      {
        method: "GET",
        agent: false,
        // The address that was checked, whatever DNS says now (rebinding).
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)) as never,
        headers: {
          "user-agent": "libi",
          accept: "audio/*, video/*",
          ...(range ? { range } : {}),
        },
        signal,
      },
      undefined,
    );
    const timer = setTimeout(() => req.destroy(new AssetStreamRefusal("timeout", "The media's host didn't answer in time.")), deps.headersTimeoutMs);
    req.on("response", (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof AssetStreamRefusal || signal.aborted ? err : new AssetStreamRefusal("unreachable", "Couldn't reach the media's host."));
    });
    req.end();
  });
}

/** The body, cut at the byte cap, when it stalls, and when it has run too long in all. */
function guarded(res: IncomingMessage): Readable {
  let seen = 0;
  let idle: ReturnType<typeof setTimeout>;
  // eslint-disable-next-line prefer-const -- assigned once `t` exists
  let overall: ReturnType<typeof setTimeout>;
  const arm = (t: Transform) => {
    clearTimeout(idle);
    idle = setTimeout(() => t.destroy(new AssetStreamRefusal("timeout", "The media's host stopped sending.")), deps.idleTimeoutMs);
  };
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > ASSET_STREAM_MAX_BYTES) {
        cb(new AssetStreamRefusal("too_large", "The media is larger than libi plays inline."));
        return;
      }
      arm(t);
      cb(null, chunk);
    },
    flush(cb) {
      clearTimeout(idle);
      clearTimeout(overall);
      cb();
    },
  });
  t.on("close", () => {
    clearTimeout(idle);
    clearTimeout(overall);
    res.destroy();
  });
  overall = setTimeout(() => t.destroy(new AssetStreamRefusal("timeout", "The media took too long to arrive.")), deps.maxDurationMs);
  arm(t);
  res.on("error", (err) => t.destroy(err));
  return res.pipe(t);
}

/**
 * Open `rawUrl` for streaming under every rule above; `range` is the page's
 * own `Range` (forwarded only when it is a single byte range). Throws an
 * `AssetStreamRefusal` — never the upstream's words.
 */
export async function openAssetStream(rawUrl: string, opts: { range?: string | null; signal: AbortSignal }): Promise<AssetStream> {
  const range = forwardableRange(opts.range ?? null);
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const problem = hostedUrlProblem(current);
    if (problem) throw new AssetStreamRefusal("invalid_url", `The media's address ${problem}.`);
    const url = new URL(current);
    const pinned = await checkedAddress(url.hostname.replace(/\.+$/, ""), opts.signal);
    const res = await requestOnce(url, pinned, range, opts.signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy(); // never drained: a refused body is not ours to download
      if (hop >= ASSET_STREAM_MAX_REDIRECTS) throw new AssetStreamRefusal("too_many_redirects", "The media's address redirects too many times.");
      try {
        current = new URL(res.headers.location, url).href;
      } catch {
        throw new AssetStreamRefusal("invalid_url", "The media's host redirected to an address libi can't read.");
      }
      continue;
    }
    if (status !== 200 && status !== 206) {
      res.destroy(); // never drained: a refused body is not ours to download
      throw new AssetStreamRefusal("upstream_status", "The media's host didn't serve it.", status);
    }
    const type = String(res.headers["content-type"] ?? "").trim();
    const base = type.split(";")[0].trim().toLowerCase();
    if (!/^(audio|video)\/[a-z0-9.+-]+$/.test(base)) {
      res.destroy(); // never drained: a refused body is not ours to download
      throw new AssetStreamRefusal("wrong_type", "The address doesn't serve audio or video.");
    }
    const declared = res.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > ASSET_STREAM_MAX_BYTES)) {
      res.destroy(); // never drained: a refused body is not ours to download
      throw new AssetStreamRefusal("too_large", "The media is larger than libi plays inline.");
    }
    const headers: AssetStream["headers"] = { "content-type": base };
    if (declared !== undefined) headers["content-length"] = String(declared);
    const contentRange = res.headers["content-range"];
    if (status === 206 && typeof contentRange === "string" && /^bytes \d+-\d+\/(\d+|\*)$/.test(contentRange)) headers["content-range"] = contentRange;
    if (res.headers["accept-ranges"] === "bytes") headers["accept-ranges"] = "bytes";
    return { status: status as 200 | 206, headers, body: guarded(res), host: url.host };
  }
}
