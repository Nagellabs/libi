/**
 * The token store is the ONLY place a user's provider credential is written to
 * disk (AGENTS.md → "libi never stores a provider API key"), so these tests pin
 * the CONTRACT rather than the implementation: what a caller can get out of it,
 * what survives a missing cipher, and what never reaches a log line.
 *
 * The cipher used here is real AES-256-GCM. A toy reversing cipher would make
 * `not.toContain("at-secret")` pass even if the store wrote the plaintext
 * backwards, and would round-trip even with encrypt/decrypt wired up wrongly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { SocialTokenStore, type StoredGrant } from "@/lib/social/token-store";
import { registerSecretCipher, type SecretCipher } from "@/lib/social/secret-cipher";

const grant: StoredGrant = {
  tokens: { access_token: "at-secret", refresh_token: "rt-secret", expires_at: 1 },
  client: { client_id: "c", client_secret: "cs-secret" },
  codeVerifier: "cv-secret",
  connectedAt: "2026-09-20T00:00:00Z",
  scopes: ["posts:read"],
};
/** Every credential string in `grant` — nothing below may ever print one. */
const SECRETS = ["at-secret", "rt-secret", "cs-secret", "cv-secret"];

/** A genuine cipher, so "no plaintext in the file" can only pass honestly. */
const KEY = crypto.createHash("sha256").update("libi-test-keychain").digest();
const aes: SecretCipher = {
  label: "keychain",
  encrypt: (plain) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  },
  decrypt: (blob) => {
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
  },
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-social-"));
  registerSecretCipher(null);
  for (const fn of Object.values(logSpies)) fn.mockClear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  registerSecretCipher(null);
});

/** The raw bytes of the grant file, blob included (base64 decoded). */
function fileBytes(p: string): string {
  const body = fs.readFileSync(p, "utf8");
  const env = JSON.parse(body) as { enc: string; blob?: string };
  const decoded = env.blob ? Buffer.from(env.blob, "base64").toString("latin1") : "";
  return body + decoded;
}

describe("SocialTokenStore", () => {
  it("writes a 0600 file under <dir>/social and reads it back", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    const p = s.path();
    expect(p).toBe(path.join(dir, "social", "zernio.tokens.json"));
    if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(s.readSecret()).toEqual(grant);
    expect(s.where()).toBe("file");
  });

  it("clear() removes the file; readSecret() is null after", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("disconnected");
    expect(fs.existsSync(s.path())).toBe(false);
    expect(s.readSecret()).toBeNull();
  });

  it("uses the registered cipher: neither the file nor its decoded blob holds a secret", () => {
    registerSecretCipher(aes);
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    const bytes = fileBytes(s.path());
    for (const secret of SECRETS) expect(bytes).not.toContain(secret);
    expect(s.readSecret()).toEqual(grant);
    expect(s.where()).toBe("keychain");
  });

  it("a corrupt file reads as null, never throws", () => {
    const s = new SocialTokenStore("zernio", dir);
    fs.mkdirSync(path.join(dir, "social"), { recursive: true });
    fs.writeFileSync(s.path(), "{not json");
    expect(s.readSecret()).toBeNull();
    expect(s.status().connected).toBe(false);
  });

  // ── The contract, not the implementation ───────────────────────────────

  it("an ENCRYPTED grant with NO cipher registered is a clean 'not connected'", () => {
    registerSecretCipher(aes);
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);

    // The npx process, or the out-of-process serve-mcp-http child: same file,
    // no cipher. It must read as absent, not throw and not half-answer.
    registerSecretCipher(null);
    expect(() => s.readSecret()).not.toThrow();
    expect(s.readSecret()).toBeNull();
    // `revoked: false` matters here: an unreadable grant is not a rejected
    // one, and must not put "your connection was revoked" in front of a user
    // whose keychain simply is not available yet.
    expect(s.status()).toEqual({ connected: false, revoked: false, scopes: [], where: "keychain" });
  });

  it("a PLAINTEXT grant read WITH a cipher registered is healed on disk", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant); // written under npx
    expect(JSON.parse(fs.readFileSync(s.path(), "utf8")).enc).toBe("none");

    registerSecretCipher(aes); // …then opened in the desktop app
    expect(s.where()).toBe("file"); // what is ACTUALLY on disk, not the cipher
    expect(s.readSecret()).toEqual(grant);

    expect(JSON.parse(fs.readFileSync(s.path(), "utf8")).enc).toBe("keychain");
    const bytes = fileBytes(s.path());
    for (const secret of SECRETS) expect(bytes).not.toContain(secret);
    expect(s.where()).toBe("keychain");
    if (process.platform !== "win32") {
      expect(fs.statSync(s.path()).mode & 0o777).toBe(0o600);
    }
  });

  it("clear() also removes a temp file left by a crashed write", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    // Both shapes: the fixed `.tmp` an older build used, and a random one.
    const stray = [`${s.path()}.tmp`, `${s.path()}.deadbeefdeadbeef.tmp`];
    for (const t of stray) fs.writeFileSync(t, JSON.stringify({ v: 1, enc: "none", grant }));

    s.clear("disconnected");

    for (const t of stray) expect(fs.existsSync(t)).toBe(false);
    expect(fs.readdirSync(path.join(dir, "social"))).toEqual([]);
  });

  it("status() is the non-secret view — no field can carry a credential", () => {
    registerSecretCipher(aes);
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);

    const status = s.status();
    expect(status).toEqual({
      connected: true,
      revoked: false,
      connectedAt: grant.connectedAt,
      scopes: grant.scopes,
      where: "keychain",
    });
    const serialized = JSON.stringify(status);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
  });

  it("no log call ever carries a token value, on any path", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);              // plaintext write
    s.readSecret();
    s.status();
    registerSecretCipher(aes);
    s.readSecret();              // self-heal (re-encrypt)
    s.write(grant);              // encrypted write
    s.readSecret();
    registerSecretCipher(null);
    s.readSecret();              // encrypted, no cipher
    fs.writeFileSync(s.path(), `{"v":1,"enc":"none","grant":{"tokens":{"access_token":"at-secret"`);
    s.readSecret();              // truncated JSON — the parse error quotes the source
    s.clear("revoked");

    const calls = Object.values(logSpies).flatMap((fn) => fn.mock.calls);
    expect(calls.length).toBeGreaterThan(0);
    const printed = JSON.stringify(calls);
    for (const secret of SECRETS) expect(printed).not.toContain(secret);
  });
});

/**
 * A cleared grant and a fresh install are the SAME absent file, and the store
 * used to answer them identically — so a user the provider had just signed out
 * was shown "Connect libi" and told nothing. These pin the one bit that tells
 * them apart, and that it costs nothing on disk but a timestamp.
 */
describe("SocialTokenStore — a revoked grant is not a fresh install", () => {
  it("never connected: no grant, and nothing claims it was revoked", () => {
    const s = new SocialTokenStore("zernio", dir);
    expect(s.status()).toEqual({ connected: false, revoked: false, scopes: [], where: "file" });
  });

  it("clear('revoked') answers connected:false + revoked:true", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("revoked");
    expect(s.readSecret()).toBeNull();
    expect(s.status()).toMatchObject({ connected: false, revoked: true });
  });

  it("clear('disconnected') is NOT revoked — the user asked for it", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("disconnected");
    expect(s.status()).toMatchObject({ connected: false, revoked: false });
  });

  it("the marker survives a restart: a new store over the same home still says revoked", () => {
    new SocialTokenStore("zernio", dir).write(grant);
    new SocialTokenStore("zernio", dir).clear("revoked");
    // A different instance, as a relaunched server would build.
    expect(new SocialTokenStore("zernio", dir).status()).toMatchObject({ connected: false, revoked: true });
  });

  it("the marker holds a version and a time and NOTHING else — no token, no scopes, no client", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("revoked");
    const markers = fs.readdirSync(path.join(dir, "social"));
    expect(markers).toEqual(["zernio.revoked.json"]);
    const raw = fs.readFileSync(path.join(dir, "social", "zernio.revoked.json"), "utf8");
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["revokedAt", "v"]);
    expect(typeof parsed.revokedAt).toBe("string");
    // Not "does it parse" — the value has to be a real moment, since it is the
    // only thing the marker carries.
    expect(Number.isFinite(Date.parse(String(parsed.revokedAt)))).toBe(true);
  });

  it("a completed sign-in un-revokes: the marker does not outlive the grant that replaces it", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("revoked");
    expect(s.status()).toMatchObject({ revoked: true });

    s.write(grant);
    expect(s.status()).toMatchObject({ connected: true, revoked: false });
    expect(fs.existsSync(path.join(dir, "social", "zernio.revoked.json"))).toBe(false);
  });

  it("a live grant is never reported revoked, even with a stale marker beside it", () => {
    const s = new SocialTokenStore("zernio", dir);
    // Hand-planted, as a marker from an older sign-in would be.
    fs.mkdirSync(path.join(dir, "social"), { recursive: true });
    fs.writeFileSync(path.join(dir, "social", "zernio.revoked.json"), JSON.stringify({ v: 1, revokedAt: "2020-01-01T00:00:00.000Z" }));
    fs.writeFileSync(s.path(), JSON.stringify({ v: 1, enc: "none", grant }));
    expect(s.status()).toMatchObject({ connected: true, revoked: false });
  });

  it("the marker is not mistaken for a crashed write's temp file", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("revoked");
    // `clear()` sweeps `<grant>.<hex>.tmp`; the marker must not be swept with
    // it, or the whole mechanism silently does nothing.
    s.clear("revoked");
    expect(s.status()).toMatchObject({ revoked: true });
  });
});

/**
 * "Connected" is the grant file's EXISTENCE, which means it has to be read
 * again every time — a process that answered from what it read at boot is a
 * process that keeps claiming a connection after the grant has been destroyed
 * underneath it, which is exactly what a running server was observed doing.
 */
describe("SocialTokenStore — the file is re-read, never remembered", () => {
  it("a grant deleted underneath a LIVE store reads as not connected on the very next call", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    expect(s.status()).toMatchObject({ connected: true });

    // Not `clear()` — the file just goes, as the SDK's auth recovery or
    // another process removing it leaves things. Same instance throughout.
    fs.rmSync(s.path(), { force: true });

    expect(s.readSecret()).toBeNull();
    expect(s.status()).toEqual({ connected: false, revoked: false, scopes: [], where: "file" });
  });
});

/**
 * A scope list is a claim about what libi is ALLOWED to do, printed to the
 * user as chips on the Settings tab. It has to be what the provider issued:
 * libi asking for four scopes and being given three is the documented steady
 * state here (0a6d79c9 — the ads gap), not a corner case.
 */
describe("SocialTokenStore — scopes are what the provider issued", () => {
  it("reports the issued scope, not the requested one, when they differ", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write({
      ...grant,
      scopes: ["accounts:read", "posts:read", "posts:write", "analytics:read"],
      tokens: { ...grant.tokens, scope: "accounts:read posts:read" },
    });
    expect(s.status().scopes).toEqual(["accounts:read", "posts:read"]);
  });

  it("falls back to the requested scopes when the response carried none (RFC 6749 §5.1)", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write({ ...grant, scopes: ["posts:read", "posts:write"] });
    expect(s.status().scopes).toEqual(["posts:read", "posts:write"]);
  });

  it("treats a blank issued scope as 'none carried', not as no scopes at all", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write({ ...grant, scopes: ["posts:read"], tokens: { ...grant.tokens, scope: "   " } });
    expect(s.status().scopes).toEqual(["posts:read"]);
  });

  it("a connected status always carries at least one scope — an empty list is the tell of an absent grant", () => {
    const s = new SocialTokenStore("zernio", dir);
    expect(s.status()).toMatchObject({ connected: false, scopes: [] });
    s.write(grant);
    const st = s.status();
    expect(st.connected).toBe(true);
    expect(st.scopes.length).toBeGreaterThan(0);
  });
});

/**
 * Test mode's grant is the local fake's, and it lives in the same folder as a
 * real one. Outside test mode it has to be invisible: its "token" is the
 * fake's fixed bearer, and presenting that to real Zernio is a 401 — which is
 * a "your connection was revoked" for a sign-in the user never lost.
 */
describe("SocialTokenStore — a test-mode grant is not the user's", () => {
  const fake: StoredGrant = { ...grant, testMode: true };

  afterEach(() => { vi.unstubAllEnvs(); });

  it("is readable while test mode is on", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const s = new SocialTokenStore("zernio", dir);
    s.write(fake);
    expect(s.status()).toMatchObject({ connected: true });
    expect(s.readSecret()).toEqual(fake);
  });

  it("reads as absent once test mode is off — never as connected, never as revoked", () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const s = new SocialTokenStore("zernio", dir);
    s.write(fake);
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(s.readSecret()).toBeNull();
    expect(s.status()).toMatchObject({ connected: false, revoked: false, scopes: [] });
  });

  it("does not erase a real revoked marker it is written on top of", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("revoked");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    s.write(fake);
    vi.stubEnv("LIBI_TEST_MODE", "");
    // Back out of test mode and the user is where they were: signed out by
    // the provider, and told so.
    expect(s.status()).toMatchObject({ connected: false, revoked: true });
  });

  it("a real sign-in still un-revokes", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    s.clear("revoked");
    s.write(grant);
    expect(s.status()).toMatchObject({ connected: true, revoked: false });
  });
});

/**
 * On macOS asking the OS whether it can encrypt IS a keychain read, and a read
 * the item's access list doesn't cover is a login-password prompt. The shell's
 * cipher answers `available()` lazily (electron/secret-cipher.ts); these pin
 * that the store asks only when a grant is about to be written — never for a
 * status check on a machine with nothing stored (owner report 2026-09-29: a
 * keychain prompt at every launch of the installed app, no grant on disk).
 */
describe("SocialTokenStore — the keychain is asked only when a grant is written", () => {
  function lazyAes(isAvailable = true) {
    return {
      label: "keychain" as const,
      available: vi.fn(() => isAvailable),
      encrypt: vi.fn(aes.encrypt),
      decrypt: vi.fn(aes.decrypt),
    };
  }

  it("with no grant, status() and where() never touch the cipher", () => {
    const c = lazyAes();
    registerSecretCipher(c);
    const s = new SocialTokenStore("zernio", dir);
    expect(s.status()).toMatchObject({ connected: false, revoked: false, where: "keychain" });
    expect(s.readSecret()).toBeNull();
    expect(c.available).not.toHaveBeenCalled();
    expect(c.encrypt).not.toHaveBeenCalled();
    expect(c.decrypt).not.toHaveBeenCalled();
  });

  it("an encrypted grant is read with decrypt alone — no availability check", () => {
    const c = lazyAes();
    registerSecretCipher(c);
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    c.available.mockClear();
    expect(s.readSecret()).toEqual(grant);
    expect(c.decrypt).toHaveBeenCalledTimes(1);
    expect(c.available).not.toHaveBeenCalled();
  });

  it("encryption unavailable: the write stays a private plaintext file, never a failed connect", () => {
    const c = lazyAes(false);
    registerSecretCipher(c);
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    expect(c.encrypt).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(s.path(), "utf8")).enc).toBe("none");
    if (process.platform !== "win32") expect(fs.statSync(s.path()).mode & 0o777).toBe(0o600);
    expect(s.readSecret()).toEqual(grant);
    expect(s.where()).toBe("file");
  });

  it("encryption unavailable: a plaintext grant is not 'healed' (and warned about) on every read", () => {
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    const c = lazyAes(false);
    registerSecretCipher(c);
    expect(s.readSecret()).toEqual(grant);
    expect(s.readSecret()).toEqual(grant);
    expect(c.encrypt).not.toHaveBeenCalled();
    expect(logSpies.warn).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(s.path(), "utf8")).enc).toBe("none");
  });

  it("a cipher from an older shell (no available()) still encrypts", () => {
    registerSecretCipher(aes);
    const s = new SocialTokenStore("zernio", dir);
    s.write(grant);
    expect(JSON.parse(fs.readFileSync(s.path(), "utf8")).enc).toBe("keychain");
  });
});
