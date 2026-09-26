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
  it("redacts a dev build's Vercel bypass token — by key name, and by value once it is live", async () => {
    const { serverLogger } = await import("@/lib/logger");
    const { registerLiveSecret } = await import("@/lib/security/secret-scrub");
    const token = "BypassLogRedact0123456789abcdef";
    registerLiveSecret(token);
    serverLogger.info({ tag: "test", op: "redact_probe_bypass", setting: { bypassToken: "bypass-by-key-0001" }, message: `quoted ${token}` }, `in the text ${token}`);
    const body = await readLogEventually(home);
    expect(body).toContain("redact_probe_bypass");
    expect(body).not.toContain("bypass-by-key-0001");
    expect(body).not.toContain(token);
  });

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

  it("redacts the social grant's own carriers (access_token, client_secret, …)", async () => {
    // pino matches WHOLE key names: "token" does not cover "access_token" and
    // "secret" does not cover "client_secret", so libi's OAuth grant
    // (lib/social/token-store.ts) was outside the backstop until these were
    // listed. The store never logs a grant — this is the layer under that.
    const { serverLogger } = await import("@/lib/logger");
    serverLogger.info(
      {
        tag: "test",
        op: "redact_probe_grant",
        grant: {
          tokens: { access_token: "sk-LOGREDACT-5", refresh_token: "sk-LOGREDACT-6" },
          client: { client_secret: "sk-LOGREDACT-7" },
          codeVerifier: "sk-LOGREDACT-8",
        },
        blob: "sk-LOGREDACT-9",
        // The same secret under the OAuth wire name, as a payload built from a
        // token request body would carry it.
        body: { code_verifier: "sk-LOGREDACT-10" },
      },
      "carries a whole grant",
    );

    const body = await readLogEventually(home);
    expect(body).toContain("redact_probe_grant");
    for (const n of [5, 6, 7, 8, 9, 10]) expect(body).not.toContain(`sk-LOGREDACT-${n}`);
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
