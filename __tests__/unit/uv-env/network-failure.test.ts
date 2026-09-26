/**
 * lib/uv-env/network-failure.ts — the one regression the managed-Python switch
 * introduces (an env built on a system Python is rebuilt on first use, which
 * needs a one-time CPython download) must read as one plain sentence when the
 * machine is offline, not a wall of uv "Caused by:" lines. Fixtures are uv
 * 0.11.32's real output, captured 2026-09-25 behind a dead proxy / a bad host.
 */
import { describe, it, expect, vi } from "vitest";
import { serverLogger } from "@/lib/logger";
import {
  describeUvNetworkFailure,
  uvNetworkFailureMessage,
  isNetworkCause,
  MANAGED_PYTHON_DOWNLOAD_MB,
} from "@/lib/uv-env/network-failure";
import { analyzeFailureMessage } from "@/lib/music/analyze";

const PYTHON_OFFLINE = `error: Request failed after 3 retries in 9.5s
  Caused by: Failed to download https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz
  Caused by: error sending request for url (https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz)
  Caused by: client error (Connect)
  Caused by: tunnel error: failed to create underlying connection
  Caused by: tcp connect error
  Caused by: Connection refused (os error 61)`;

const PACKAGES_OFFLINE = `error: Request failed after 3 retries in 7.7s
  Caused by: Failed to fetch: \`https://pypi.org/simple/six/\`
  Caused by: error sending request for url (https://pypi.org/simple/six/)
  Caused by: client error (Connect)
  Caused by: tcp connect error
  Caused by: Connection refused (os error 61)`;

const PYTHON_DNS = `error: Request failed after 3 retries in 9.1s
  Caused by: Failed to download https://nonexistent.invalid/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz
  Caused by: error sending request for url (https://nonexistent.invalid/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz)
  Caused by: client error (Connect)
  Caused by: dns error
  Caused by: failed to lookup address information: nodename nor servname provided, or not known`;

describe("describeUvNetworkFailure", () => {
  it("names the one-time managed-Python download and the feature, and nothing of uv's text", () => {
    for (const raw of [PYTHON_OFFLINE, PYTHON_DNS]) {
      const msg = describeUvNetworkFailure("transcription", raw)!;
      expect(msg).toBe(
        `libi needs a one-time download of its own Python (about ${MANAGED_PYTHON_DOWNLOAD_MB} MB) for transcription, ` +
          "and this computer appears to be offline. Try again when you're online.",
      );
      expect(msg).not.toMatch(/Caused by|github|tcp/);
    }
  });

  it("says 'Python packages' when uv could not fetch the packages rather than Python itself", () => {
    expect(describeUvNetworkFailure("voiceover", PACKAGES_OFFLINE)).toBe(
      "libi needs to download the Python packages for voiceover (a one-time step), and this computer appears to be offline. Try again when you're online.",
    );
  });

  it("returns null for anything that is not uv failing a request", () => {
    // a Python traceback from the program uv ran, even a network one
    expect(
      describeUvNetworkFailure("transcription", "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='huggingface.co')"),
    ).toBeNull();
    expect(describeUvNetworkFailure("music generation", "RuntimeError: CUDA out of memory")).toBeNull();
    expect(describeUvNetworkFailure("object tracking", "error: No solution found when resolving dependencies")).toBeNull();
  });

  it("uvNetworkFailureMessage keeps the raw uv text in the log only", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    try {
      const msg = uvNetworkFailureMessage("object tracking", PYTHON_OFFLINE)!;
      expect(msg).not.toContain("Caused by");
      const call = warn.mock.calls.find((c) => (c[0] as { op?: string }).op === "uv_offline")!;
      expect(call[0]).toMatchObject({ tag: "uv-env", feature: "object tracking" });
      expect((call[0] as { stderr: string }).stderr).toContain("Caused by: tcp connect error");
      warn.mockClear();
      expect(uvNetworkFailureMessage("object tracking", "some other failure")).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("isNetworkCause still recognises the causes the video-download message keys on", () => {
    expect(isNetworkCause("getaddrinfo ENOTFOUND github.com")).toBe(true);
    expect(isNetworkCause("OSError: [Errno 28] No space left on device")).toBe(false);
  });
});

// F4 (final review): uv 0.11.32's real output, captured 2026-09-25 against a local index / Python
// mirror answering 401, 404 and 500, one serving a self-signed certificate (what a TLS-intercepting
// proxy looks like to uv), and a 4 MB disk image for the disk-full case. None of these is "offline".
const PYTHON_MIRROR_404 = `error: Failed to install cpython-3.10.20-macos-aarch64-none
  Caused by: Request failed after 3 retries in 35.1s
  Caused by: Failed to download http://127.0.0.1:18767/mirror/20260718/cpython-3.10.20%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz
  Caused by: HTTP status client error (404 File not found) for url (http://127.0.0.1:18767/mirror/20260718/cpython-3.10.20%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz)`;

const INDEX_500 = `Using CPython 3.12.13
error: Request failed after 3 retries in 34.0s
  Caused by: Failed to fetch: \`http://127.0.0.1:18765/boom/simple/six/\`
  Caused by: HTTP status server error (500 Internal Server Error) for url (http://127.0.0.1:18765/boom/simple/six/)`;

// A package whose NAME reads as network (pyopenssl → "ssl"), answered 404 by a private index.
const INDEX_404_NETWORKY_NAME = `error: Request failed after 3 retries in 2.1s
  Caused by: Failed to fetch: \`https://pypi.example.com/simple/pyopenssl/\`
  Caused by: HTTP status client error (404 Not Found) for url (https://pypi.example.com/simple/pyopenssl/)`;

const INDEX_401 = `error: Failed to fetch: \`https://pypi.example.com/simple/requests-oauthlib/\`
  Caused by: HTTP status client error (401 Unauthorized) for url (https://pypi.example.com/simple/requests-oauthlib/)`;

const PYTHON_CERT = `error: Failed to install cpython-3.10.20-macos-aarch64-none
  Caused by: Failed to download https://127.0.0.1:18766/mirror/20260718/cpython-3.10.20%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz
  Caused by: error sending request for url (https://127.0.0.1:18766/mirror/20260718/cpython-3.10.20%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz)
  Caused by: client error (Connect)
  Caused by: invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))`;

const INDEX_CERT = `Using CPython 3.12.13
error: Failed to fetch: \`https://127.0.0.1:18766/simple/six/\`
  Caused by: error sending request for url (https://127.0.0.1:18766/simple/six/)
  Caused by: client error (Connect)
  Caused by: invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))

hint: Consider enabling use of system TLS certificates with the \`--system-certs\` command-line flag`;

// Disk full mid-download of the managed Python (the request line is present, the cause is the disk).
const PYTHON_DISK_FULL = `error: Failed to install cpython-3.12.13-macos-aarch64-none
  Caused by: Failed to download https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz
  Caused by: Failed to extract archive: cpython-3.12.13-20260718-aarch64-apple-darwin-install_only_stripped.tar.gz
  Caused by: I/O operation failed during extraction
  Caused by: failed to unpack \`python/bin/python3.12\` into \`/Users/me/.libi/uv/python/.temp/.tmpJVrTmZ/python/bin/python3.12\`
  Caused by: No space left on device (os error 28)`;

describe("describeUvNetworkFailure — only a network cause on a `Caused by:` line is offline (F4)", () => {
  it.each([
    ["the Python mirror answering 404", PYTHON_MIRROR_404],
    ["the index answering 500", INDEX_500],
    ["a 404 for a package whose name reads as network", INDEX_404_NETWORKY_NAME],
    ["a 401 from a private index", INDEX_401],
    ["a disk-full download", PYTHON_DISK_FULL],
  ])("%s is not offline", (_label, raw) => {
    expect(describeUvNetworkFailure("transcription", raw)).toBeNull();
  });

  it.each([
    ["the managed Python", PYTHON_CERT],
    ["the package index", INDEX_CERT],
  ])("a certificate error fetching %s (a TLS-intercepting proxy) is not called offline", (_label, raw) => {
    expect(describeUvNetworkFailure("object tracking", raw)).toBeNull();
  });

  it("a network word only in a URL does not count", () => {
    const raw = `error: Request failed after 3 retries in 1.0s
  Caused by: Failed to fetch: \`https://proxy.network.example/simple/ssl-timed-out/\`
  Caused by: some other failure`;
    expect(describeUvNetworkFailure("voiceover", raw)).toBeNull();
  });

  it("the offline shapes still read as offline", () => {
    for (const raw of [PYTHON_OFFLINE, PACKAGES_OFFLINE, PYTHON_DNS]) {
      expect(describeUvNetworkFailure("transcription", raw)).toMatch(/appears to be offline/);
    }
  });
});

describe("music analysis: uv's exit 2 is not a usage error", () => {
  it("an offline uv run is reported as offline, in plain words", () => {
    const m = analyzeFailureMessage(2, PACKAGES_OFFLINE);
    expect(m.startsWith("offline: libi needs to download the Python packages for music analysis")).toBe(true);
  });
  it("another uv error is `uv_error`, and only argparse's `usage:` is `usage_error`", () => {
    expect(analyzeFailureMessage(2, "error: No solution found when resolving dependencies")).toMatch(/^uv_error: /);
    expect(
      analyzeFailureMessage(2, "usage: analyze.py [-h] --mode {beats,profile}\nanalyze.py: error: the following arguments are required: --in"),
    ).toMatch(/^usage_error: /);
    expect(analyzeFailureMessage(1, "file_not_found: /x.wav")).toMatch(/^exited 1: /);
  });
});
