import { describe, it, expect } from "vitest";
import { binaryInstallHints } from "@/lib/server/lifecycle/install-error-hints";

describe("binaryInstallHints", () => {
  it("detects NODE_MODULE_VERSION ABI mismatches and points at the rebuild script", () => {
    const msg =
      "The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 135. This version of Node.js requires NODE_MODULE_VERSION 137.";
    const hints = binaryInstallHints(msg);
    expect(hints).toContain("ABI mismatch");
    expect(hints).toContain("scripts/ensure-native-modules.js");
    expect(hints).not.toContain("SHA256");
  });

  it("detects ERR_DLOPEN failures as ABI problems too", () => {
    const hints = binaryInstallHints("Error: ERR_DLOPEN_FAILED: dlopen(...)");
    expect(hints).toContain("ABI mismatch");
  });

  it("keeps the generic download hints for everything else", () => {
    const hints = binaryInstallHints("sha256 mismatch for ffmpeg: expected abc got def");
    expect(hints).toContain("No network connection");
    expect(hints).toContain("SHA256 mismatch");
    expect(hints).not.toContain("ABI mismatch");
    expect(hints).not.toContain("is unreachable");
  });

  // An install that cannot finish because a host is unreachable gets its own
  // words, and NAMES the host. libi downloads from the npm registry,
  // github.com and electronjs.org independently — a corporate proxy typically
  // blocks one and not the others, and "check your network" sends that user
  // looking in the wrong place.
  it("names the unreachable host when a required download cannot be reached", () => {
    const hints = binaryInstallHints(
      "request to https://github.com/yt-dlp/yt-dlp/releases/download/x failed, reason: getaddrinfo ENOTFOUND github.com",
    );
    expect(hints).toContain("github.com is unreachable");
    expect(hints).toContain("Check your connection or proxy");
    expect(hints).not.toContain("SHA256 mismatch");
  });

  it("still says it is a network problem when no host is quotable", () => {
    const hints = binaryInstallHints("connect ETIMEDOUT 140.82.121.4:443");
    expect(hints).toContain("could not be reached");
    expect(hints).not.toContain("ABI mismatch");
  });

  it("carries a support address that actually exists", () => {
    // NOT the GitHub issues URL — the repo is private and that link 404s.
    expect(binaryInstallHints("anything")).toContain("support@nagellabs.com");
  });
});
