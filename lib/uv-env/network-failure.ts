// lib/uv-env/network-failure.ts
//
// Plain words for the one failure libi's managed-Python switch can introduce
// (lib/uv-env/spawn-env.ts UV_PYTHON_PREFERENCE): an install built on a
// system Python is rebuilt on its next use, and that first use needs a
// one-time download of libi's own CPython. Offline, uv then fails with a
// wall of "Caused by:" lines. Every uv call site that surfaces an error to a
// user or an agent turns THAT failure into one sentence — the raw text goes to
// the log, not into the message.
//
// No uv spawn here; safe for the MCP child and the server alike.

import { serverLogger as logger } from "@/lib/logger";
import { MANAGED_PYTHON_DOWNLOAD_MB } from "@/lib/uv-env/managed-python-size";

/** Text that reads as the network, not the install: DNS, refused / reset /
 *  timed-out connections, proxies, TLS, and uv's and fetch's own phrasings
 *  of the same. */
const NETWORK_CAUSE_RE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|dns error|failed to lookup address|tcp connect|connection refused|connection reset|timed out|failed to fetch|fetch failed|error sending request|could not connect|network|proxy|certificate|tls|ssl/i;

/** uv's OWN request-failure lines (uv 0.11.32 / 0.12.19): "error: Request
 *  failed after N retries", "Failed to download <url>", "Failed to fetch:
 *  `<url>`", "error sending request for url". Required so a network error
 *  raised by the Python program uv RAN (a HuggingFace model fetch, say) is not
 *  mistaken for uv failing to set up the environment. */
const UV_REQUEST_FAILURE_RE =
  /Request failed after \d+ retr|Failed to download https?:|Failed to fetch: `?https?:|error sending request for url/;

/** uv reached a server and it answered, or the failure is local: never "offline". Real uv
 *  0.11.32 shapes: "HTTP status client error (404 Not Found) for url (…)", "HTTP status server
 *  error (500 …)", a 401 from a private index, and "No space left on device (os error 28)". */
const UV_NOT_OFFLINE_RE = /HTTP status client error|HTTP status server error|No space left/i;

/** A certificate uv would not accept — typically a TLS-intercepting proxy or security software
 *  ("invalid peer certificate: UnknownIssuer", "…CaUsedAsEndEntity"). The machine is online; the
 *  remedy is the proxy's certificate, so it is not reported as offline. */
const UV_CERTIFICATE_RE = /certificate|UnknownIssuer|CaUsedAsEndEntity|self[- ]signed/i;

/** uv's "Caused by:" lines, minus the ones that only restate WHICH request failed, with URLs and
 *  quoted names removed — a package or host whose name reads as network ("pyopenssl", "proxy.…")
 *  says nothing about why the request failed. */
function uvCauses(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => /^\s*Caused by:/.test(line) && !UV_REQUEST_FAILURE_RE.test(line))
    .map((line) => line.replace(/`[^`]*`/g, "").replace(/\(?\bhttps?:\/\/[^\s)]*\)?/g, ""));
}

/** The request that failed was the managed CPython itself. */
const UV_PYTHON_DOWNLOAD_RE = /python-build-standalone|cpython-\d+\.\d+/i;

export { MANAGED_PYTHON_DOWNLOAD_MB };

/** True when `text` reads as a network failure (any source). */
export function isNetworkCause(text: string): boolean {
  return NETWORK_CAUSE_RE.test(text);
}

/**
 * The user-facing sentence for a uv run that failed because it could not
 * download what it needed, or null when `stderr` is anything else (then the
 * caller keeps its own message). "Offline" needs a network cause on one of
 * uv's own "Caused by:" lines; a server that answered (401/404/500), a full
 * disk, or a certificate uv refused (a TLS-intercepting proxy) is not offline
 * and returns null.
 *
 * `feature` names what the user was doing, in their words — "transcription",
 * "voiceover", "music generation", "object tracking".
 */
export function describeUvNetworkFailure(feature: string, stderr: string): string | null {
  if (!UV_REQUEST_FAILURE_RE.test(stderr) || UV_NOT_OFFLINE_RE.test(stderr)) return null;
  const causes = uvCauses(stderr);
  if (causes.some((line) => UV_CERTIFICATE_RE.test(line))) return null;
  if (!causes.some(isNetworkCause)) return null;
  if (UV_PYTHON_DOWNLOAD_RE.test(stderr)) {
    return (
      `libi needs a one-time download of its own Python (about ${MANAGED_PYTHON_DOWNLOAD_MB} MB) ` +
      `for ${feature}, and this computer appears to be offline. Try again when you're online.`
    );
  }
  return (
    `libi needs to download the Python packages for ${feature} (a one-time step), ` +
    "and this computer appears to be offline. Try again when you're online."
  );
}

/**
 * `describeUvNetworkFailure`, plus the raw uv output in the log (tag
 * `uv-env`, op `uv_offline`) — the message the user sees carries none of it.
 * Returns null, logging nothing, for any other failure.
 */
export function uvNetworkFailureMessage(feature: string, stderr: string): string | null {
  const message = describeUvNetworkFailure(feature, stderr);
  if (message) {
    logger.warn(
      { tag: "uv-env", op: "uv_offline", feature, stderr: stderr.slice(-2000) },
      "uv could not download what it needed; reporting it as offline",
    );
  }
  return message;
}
