import { promises as dnsPromises } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

/**
 * Numeric CIDR ranges, checked via `node:net`'s `BlockList` (real subnet
 * containment) rather than the string-prefix heuristics this replaced.
 * `startsWith("fd")` / `startsWith("fc")` matched HOSTNAMES too — `fcc.gov`
 * and `fdn.fr` were wrongly rejected as private addresses — because a prefix
 * check can't tell "this string looks like it starts with a private IPv6
 * range" from "this string literally IS that range". `BlockList` only ever
 * matches a genuine address inside the subnet.
 */
const V4_PRIVATE_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["127.0.0.0", 8], // loopback
  ["10.0.0.0", 8], // RFC1918
  ["172.16.0.0", 12], // RFC1918
  ["192.168.0.0", 16], // RFC1918
  ["169.254.0.0", 16], // link-local (incl. cloud metadata, 169.254.169.254)
  ["0.0.0.0", 8], // "this" network
  ["100.64.0.0", 10], // CGNAT (RFC6598)
  ["192.0.0.0", 24], // IETF protocol assignments (RFC6890)
  ["198.18.0.0", 15], // benchmarking (RFC2544)
];
const V6_PRIVATE_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["::1", 128], // loopback
  ["::", 128], // unspecified — `http://[::]/` binds to the loopback/wildcard
  // interface just like `0.0.0.0` does for IPv4 (which the 0.0.0.0/8 range
  // above already blocks); this entry was previously MISSING entirely, so
  // `[::]` sailed through every check undetected.
  ["fc00::", 7], // ULA fc00::/7 (covers both fc00::/8 and fd00::/8)
  ["fe80::", 10], // link-local
  ["64:ff9b::", 96], // NAT64 well-known prefix (RFC6052)
];

const V4_BLOCKLIST = new BlockList();
for (const [addr, prefix] of V4_PRIVATE_RANGES) V4_BLOCKLIST.addSubnet(addr, prefix, "ipv4");
const V6_BLOCKLIST = new BlockList();
for (const [addr, prefix] of V6_PRIVATE_RANGES) V6_BLOCKLIST.addSubnet(addr, prefix, "ipv6");

/**
 * Extract the embedded IPv4 address from a v4-mapped IPv6 literal. WHATWG
 * `URL` (and Node's own DNS resolver) always normalize v4-mapped addresses
 * to the hex-group form `::ffff:XXXX:XXXX` — never the alternate dotted-quad
 * form `::ffff:a.b.c.d` — so that's the only shape handled here. Returns
 * null for anything else.
 *
 * (Deliberately NOT done by adding a `::ffff:0:0/96` rule to `V6_BLOCKLIST`:
 * Node's `BlockList` has a documented quirk where an IPv4-mapped IPv6 subnet
 * rule also matches EVERY plain IPv4 `check()` call, private or not —
 * verified empirically. Extracting and checking the embedded address against
 * `V4_BLOCKLIST` directly sidesteps that.)
 */
function v4MappedEmbeddedAddress(addr: string): string | null {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
}

/** How long DNS resolution gets before we treat the lookup as failed (fail-closed). */
const DNS_TIMEOUT_MS = 5_000;

/**
 * True if `addr` — a literal IPv4/IPv6 address, no brackets, no hostname —
 * falls in a loopback/private/link-local/metadata/v4-mapped/CGNAT/NAT64
 * range. Shared by the literal-hostname check and the post-DNS-resolution
 * check below so the two can never disagree about what counts as "private".
 *
 * For a genuine (non-IP-literal) hostname this returns `false` — that's not
 * a "not private" verdict, it's "not classifiable by this literal check at
 * all"; the caller still runs it through DNS resolution and checks every
 * answer the same way.
 */
function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  const mapped = v4MappedEmbeddedAddress(a);
  if (mapped) return V4_BLOCKLIST.check(mapped, "ipv4");
  const family = isIP(a);
  if (family === 4) return V4_BLOCKLIST.check(a, "ipv4");
  if (family === 6) return V6_BLOCKLIST.check(a, "ipv6");
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface VettedUrl {
  /** The parsed, validated URL. */
  url: URL;
  /**
   * An undici dispatcher pinned to the exact address(es) DNS resolution just
   * vetted as public. Pass it as `fetch(url, { dispatcher })` so the request
   * that actually opens the socket cannot re-resolve the hostname and land
   * on a different (possibly private) address than the one just checked —
   * closing the DNS-rebinding window between "check" and "connect".
   */
  dispatcher: Agent;
}

/**
 * Throws if `raw` is not a public http(s) URL. Async: beyond the literal
 * hostname/IP checks (decimal, hex, IPv6-mapped, etc. — all already
 * normalized into `url.hostname` by the WHATWG URL parser), this resolves
 * DNS and rejects if ANY returned address is private, so a hostname whose A
 * record simply points at a private/metadata address (e.g.
 * `metadata.google.internal`) no longer sails through. A lookup that errors
 * or times out is treated as untrusted and rejected — this never falls back
 * to allowing the request.
 *
 * Returns the parsed URL plus a `dispatcher` pinned to the vetted
 * address(es); pass both to `fetch` together so the connection can't
 * silently rebind to a different address after this check runs.
 */
export async function assertPublicHttpUrl(raw: string): Promise<VettedUrl> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid url: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported scheme: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  // WHATWG URL keeps the brackets on IPv6 hostnames ("[::1]"); strip them so the
  // literal-address checks below actually match.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (h === "localhost" || h.endsWith(".localhost")) {
    throw new Error(`blocked host: ${h}`);
  }
  if (isPrivateAddress(h)) {
    throw new Error(`blocked private address: ${h}`);
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await withTimeout(
      dnsPromises.lookup(h, { all: true }),
      DNS_TIMEOUT_MS,
      `dns lookup timed out: ${h}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dns lookup failed for ${h}: ${msg}`);
  }
  if (answers.length === 0) {
    throw new Error(`dns lookup returned no addresses: ${h}`);
  }
  // Reject on ANY private answer — a round-robin record mixing one public and
  // one private address must not pass on the strength of the public one.
  const privateHit = answers.find((a) => isPrivateAddress(a.address));
  if (privateHit) {
    throw new Error(`blocked private address: ${h} resolves to ${privateHit.address}`);
  }

  // Pin the connection to exactly the address(es) just vetted: this dispatcher's
  // `connect.lookup` ignores whatever the OS resolver would return for `hostname`
  // at connect time and always hands back the same vetted answers, so the socket
  // that actually opens can never land on an address DNS wasn't checked for.
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(
            null,
            answers.map((a) => ({ address: a.address, family: a.family })),
          );
        } else {
          callback(null, answers[0].address, answers[0].family);
        }
      },
    },
  });

  return { url: u, dispatcher };
}

/**
 * True if `u` is a loopback URL bound for exactly `ownPort` over plain HTTP.
 * Exported (not just used internally) so callers that need to explain a
 * rejection can distinguish "not loopback at all" from "loopback but the
 * wrong port" without duplicating the parsing.
 */
export function isOwnLoopbackUrl(u: URL, ownPort: number): boolean {
  if (u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (h !== "127.0.0.1" && h !== "::1" && h !== "localhost") return false;
  const port = u.port || "80";
  return port === String(ownPort);
}

/**
 * Validate a caller-supplied `fileUrl` that has exactly ONE legitimate
 * non-public shape: a loopback URL on THIS app's own HTTP port. The
 * tracking pipeline fetches video content back from the app's own
 * `/api/files/by-id/:id/content` route via a URL of exactly that shape
 * (`http://127.0.0.1:${getCurrentPort()}/...` — see
 * `lib/tracking/recompute-segment.ts` and `mcp/tools/tracking-tools.ts`),
 * and that must keep working even though it is, by definition, loopback —
 * `assertPublicHttpUrl` alone would reject it outright.
 *
 * Any OTHER url — including a loopback url on some OTHER port, or a
 * hostname that merely resolves to loopback/private — must pass the full
 * SSRF guard. A loopback hit skips DNS/dispatcher entirely: it's already a
 * literal address on our own process, nothing to resolve or pin.
 */
export async function assertLoopbackOrPublicHttpUrl(
  raw: string,
  ownPort: number,
): Promise<VettedUrl | { url: URL; dispatcher?: undefined }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid url: ${raw}`);
  }
  if (isOwnLoopbackUrl(u, ownPort)) {
    return { url: u };
  }
  return assertPublicHttpUrl(raw);
}
