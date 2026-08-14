const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isSafeMethod(method: string): boolean {
  return SAFE.has(method.toUpperCase());
}

function hostname(host: string | null): string | null {
  if (!host) return null;
  // strip port; handle IPv6 [::1]:port
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0];
}

export function isLoopbackHost(host: string | null): boolean {
  const h = hostname(host);
  return h != null && LOOPBACK.has(h);
}

export function evaluateRequestOrigin(input: {
  method: string;
  secFetchSite: string | null;
  host: string | null;
  origin: string | null;
  serverHost: string | null;
}): { allow: boolean; reason: string } {
  if (isSafeMethod(input.method)) return { allow: true, reason: "safe_method" };

  // DNS-rebinding gate (unconditional on mutations): the server only ever binds
  // loopback, so every legitimate request — Electron, a browser at
  // 127.0.0.1/localhost, the internal MCP-child Node client — carries a loopback
  // Host header. A rebound non-loopback Host is rejected here regardless of
  // Sec-Fetch-Site, closing the attack where `Sec-Fetch-Site: same-origin` is
  // forged with Origin/Host/serverHost all set to the attacker's rebound domain
  // (which passes the origin-vs-serverHost check because serverHost is derived
  // from the same Host header).
  if (!isLoopbackHost(input.host)) return { allow: false, reason: "non_loopback_host" };

  // An Origin header on a mutation must match this request's own server
  // host:port exactly — a cross-port loopback attacker (localhost:OTHER) is
  // still cross-origin. Malformed Origin is rejected outright.
  if (input.origin) {
    let originHost: string;
    try {
      originHost = new URL(input.origin).host;
    } catch {
      return { allow: false, reason: "bad_origin" };
    }
    if (originHost !== input.serverHost) return { allow: false, reason: "foreign_origin" };
  }

  if (input.secFetchSite != null) {
    const s = input.secFetchSite.toLowerCase();
    if (s === "same-origin" || s === "none") return { allow: true, reason: "same_origin" };
    return { allow: false, reason: "cross_site_fetch" };
  }

  // No Sec-Fetch-Site => non-browser client (internal MCP child, CLI, curl). Require loopback host.
  if (!isLoopbackHost(input.host)) return { allow: false, reason: "non_loopback_host" };
  return { allow: true, reason: "internal_client" };
}
