import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const studioSrc = readFileSync(
  path.join(process.cwd(), "lib/cli/studio.ts"),
  "utf-8",
);

describe("local server bind address", () => {
  it("passes an explicit host to server.listen", () => {
    // A bare listen(port, cb) binds 0.0.0.0 and exposes the studio to the LAN.
    expect(studioSrc).not.toMatch(/server\.listen\(\s*Number\(port\)\s*,\s*\(\)/);
    expect(studioSrc).toMatch(/server\.listen\(\s*Number\(port\)\s*,\s*host\b/);
  });

  it("defaults the host to loopback", () => {
    expect(studioSrc).toMatch(/process\.env\.LIBI_HOST\s*\|\|\s*"127\.0\.0\.1"/);
  });

  it("uses || rather than ?? so an empty LIBI_HOST doesn't bind every interface", () => {
    // `??` only falls back on null/undefined; LIBI_HOST="" would pass through
    // and Node binds an empty host to `::`. `||` is required at both sites.
    const hostFallbacks = studioSrc.match(/process\.env\.LIBI_HOST\s*(\?\?|\|\|)\s*"127\.0\.0\.1"/g) ?? [];
    expect(hostFallbacks.length).toBe(2);
    for (const match of hostFallbacks) {
      expect(match).toMatch(/\|\|/);
    }
  });

  it("pins the spawned next dev server to loopback too", () => {
    expect(studioSrc).toMatch(/"-H"\s*,\s*host/);
  });
});
