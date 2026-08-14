/**
 * Task 8: pino `redact` paths in `lib/logger.ts` are the class-wide backstop
 * behind per-call-site scrubbing (e.g. `lib/codex-config/codex-cli.ts`'s
 * `scrubSecrets` pass). `sentry.server.config.ts`'s comment above
 * `enableLogs: true` claims this is configured — this test makes that true
 * rather than just asserted.
 *
 * Writes through the REAL `serverLogger` (no mock) so the assertion covers
 * pino's actual redaction, not a stand-in for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
let prevHome: string | undefined;

/** Wait for pino's async (setImmediate-batched) destination to hit disk. */
async function readLogEventually(dir: string, timeoutMs = 3000): Promise<string> {
  const file = path.join(dir, "logs", "libi.log");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = fs.readFileSync(file, "utf8");
      if (body.length > 0) return body;
    } catch {
      /* not created yet */
    }
    if (Date.now() > deadline) return "";
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  vi.resetModules();
  prevHome = process.env.LIBI_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-log-redact-"));
  process.env.LIBI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("pino redact backstop", () => {
  it("redacts an `env` object logged directly (no scrubSecrets pass)", async () => {
    const { serverLogger } = await import("@/lib/logger");
    serverLogger.info(
      { tag: "test", op: "redact_probe_env", env: { FAL_KEY: "sk-LOGREDACT-1" } },
      "carries a raw env object",
    );

    const body = await readLogEventually(home);
    expect(body).toContain("redact_probe_env");
    expect(body).not.toContain("sk-LOGREDACT-1");
    expect(body).toContain("[redacted]");
  });

  it("redacts a nested authorization header a few levels deep", async () => {
    const { serverLogger } = await import("@/lib/logger");
    serverLogger.info(
      {
        tag: "test",
        op: "redact_probe_headers",
        request: { headers: { authorization: "Bearer sk-LOGREDACT-2" } },
      },
      "carries nested headers",
    );

    const body = await readLogEventually(home);
    expect(body).toContain("redact_probe_headers");
    expect(body).not.toContain("sk-LOGREDACT-2");
  });

  it("redacts a bare apiKey/token field", async () => {
    const { serverLogger } = await import("@/lib/logger");
    serverLogger.info(
      { tag: "test", op: "redact_probe_apikey", apiKey: "sk-LOGREDACT-3", token: "sk-LOGREDACT-4" },
      "carries apiKey and token",
    );

    const body = await readLogEventually(home);
    expect(body).not.toContain("sk-LOGREDACT-3");
    expect(body).not.toContain("sk-LOGREDACT-4");
  });
});
