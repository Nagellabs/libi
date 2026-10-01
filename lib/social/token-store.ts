import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chmodBestEffort, getLibiSocialDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { isTestMode } from "@/lib/test-mode";
import { errShape } from "./errors";
import { cipherForWrite, getSecretCipher, type SecretCipher } from "./secret-cipher";

/**
 * The OAuth client libi registered dynamically with the provider
 * (`OAuthClientInformationMixed`), kept so a re-auth reuses it.
 *
 * SECRET-BEARING: a confidential registration carries `client_secret`, which
 * is a credential in its own right. It travels with the grant and must never
 * leave `readSecret()`.
 */
export interface StoredOAuthClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris?: string[];
  [key: string]: unknown;
}

/**
 * Everything libi holds for one provider grant. SECRET in full — `tokens`,
 * `client.client_secret` and `codeVerifier` are all credentials. Only
 * `readSecret()` returns it; routes and UI use `status()`.
 */
export interface StoredGrant {
  tokens: { access_token: string; refresh_token?: string; token_type?: string; expires_at?: number; scope?: string };
  /** SECRET-BEARING — see `StoredOAuthClient`. */
  client: StoredOAuthClient | null;
  codeVerifier?: string;
  connectedAt: string;
  /**
   * What libi ASKED for. Only ever the fallback when reporting a connection —
   * see `grantedScopes`, which prefers what the provider actually issued.
   */
  scopes: string[];
  /**
   * Written by test mode's fake provider (`lib/social/test-fake.ts`), never by
   * a sign-in. Outside test mode this grant does not exist as far as every
   * reader is concerned: it holds the local fake's bearer, and presenting that
   * to the real provider is a 401 — which is to say a "your connection was
   * revoked" the user never earned, from a file they never created.
   */
  testMode?: true;
}

/** Where the grant currently lives: OS keychain (desktop) or a private file (npx). */
export type GrantLocation = "keychain" | "file";

/**
 * The non-secret view of a grant — the ONLY shape a route may serialize.
 * Deliberately has no field that could carry a token, so
 * `NextResponse.json(store.status())` is safe by construction.
 */
export interface SocialConnectionStatus {
  connected: boolean;
  /**
   * The grant was REMOVED because the provider rejected it — distinct from
   * never having had one. Only ever true when `connected` is false.
   *
   * Without this the two are indistinguishable, because "connected" here is
   * the grant file's EXISTENCE: a user whose grant was cleared read as a fresh
   * install, so the page offered "Connect libi" and said nothing about having
   * been signed out. It is a separate marker file rather than a field on the
   * grant for the obvious reason — the grant is what just got deleted.
   */
  revoked: boolean;
  connectedAt?: string;
  scopes: string[];
  where: GrantLocation;
}

/**
 * Why a grant is being removed, which the user is entitled to be told apart.
 *
 * `revoked` — the provider rejected it and a refresh could not save it. The
 * user did not ask for this and must be told to reconnect.
 * `disconnected` — the user asked libi to forget it. Not a fault, and it must
 * read as "not connected", never as "revoked".
 */
export type GrantClearReason = "revoked" | "disconnected";

/**
 * The scopes a connection actually HOLDS, which is what the provider issued —
 * not what libi asked for. RFC 6749 §5.1 makes `scope` optional in the token
 * response and defines an omitted one as "identical to the scope requested",
 * so the requested list is the fallback and only the fallback.
 *
 * The difference is not cosmetic. The Settings tab prints these as the
 * permissions libi holds, and a grant issued NARROWER than the request is the
 * documented steady state here, not a corner case: `OAUTH_SCOPES` asks for
 * four and a token that came back without one of them would still have been
 * advertised as carrying all four. That is the same class of lie as the ads
 * gap in 0a6d79c9 — a permission libi does not have, shown as one it does.
 */
function grantedScopes(grant: StoredGrant): string[] {
  const issued = (grant.tokens.scope ?? "").trim();
  return issued ? issued.split(/\s+/) : grant.scopes;
}

/** On-disk envelope. `enc: "keychain"` holds a base64 safeStorage blob; `enc: "none"` a plain grant. */
type Envelope = { v: 1; enc: "keychain"; blob: string } | { v: 1; enc: "none"; grant: StoredGrant };

/**
 * Where libi's OWN grant for a social provider lives. NEVER the DB (backups),
 * never logged, never returned by a route. `<LIBI_HOME>/social/<id>.tokens.json`
 * mode 0600 (the same posture as `~/.claude.json`), encrypted when the desktop
 * shell registered a keychain cipher.
 *
 * Two methods read it, and the split is the guard rail: `status()` answers
 * "connected?" with a shape that cannot carry a credential, and `readSecret()`
 * — named so a caller has to mean it — is the only way to the token itself.
 */
export class SocialTokenStore {
  constructor(private readonly providerId: string, private readonly home?: string) {}

  private dir(): string {
    return this.home ? path.join(this.home, "social") : getLibiSocialDir();
  }

  path(): string { return path.join(this.dir(), `${this.providerId}.tokens.json`); }

  /**
   * The revoked marker for this provider. A SEPARATE file from the grant, and
   * it holds one timestamp and a version — no token, no client, no scopes,
   * nothing that could identify the user. It exists purely so a cleared grant
   * can be told from one that never existed, across a restart.
   */
  private revokedPath(): string { return path.join(this.dir(), `${this.providerId}.revoked.json`); }

  /** Whether the last grant for this provider was cleared as REJECTED. Never
   *  consulted while a grant exists — a live grant is not revoked, whatever an
   *  older marker says. */
  private revoked(): boolean {
    try {
      return fs.existsSync(this.revokedPath());
    } catch {
      return false;
    }
  }

  /** Best effort, both ways: neither a failed marker write nor a failed
   *  removal may fail the clear or the write that is the real operation. */
  private markRevoked(revoked: boolean): void {
    try {
      if (!revoked) {
        fs.rmSync(this.revokedPath(), { force: true });
        return;
      }
      fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      // Deliberately the whole content: a version and a time. Adding anything
      // read off the grant here would put a secret in the one file written
      // precisely because the secret-bearing one is going away.
      fs.writeFileSync(this.revokedPath(), JSON.stringify({ v: 1, revokedAt: new Date().toISOString() }), { mode: 0o600 });
    } catch (err) {
      logger.warn(
        { tag: "social", op: "token_store.mark_revoked_failed", providerId: this.providerId, revoked, ...errShape(err) },
        "could not update the revoked marker",
      );
    }
  }

  /**
   * How the grant ON DISK is protected — not how a write right now would
   * protect it. A grant written under `npx` and then opened in the desktop
   * app is still a plaintext file until something reads (and so heals) it, and
   * telling the user "keychain" about it would be a lie. With no file yet,
   * this answers what the next write will MOST LIKELY do, without asking the
   * keychain (`cipherForWrite()` would — a password prompt for a status line).
   * A Linux box with no keyring is the one case it gets wrong, until the
   * first write, and the answer read back after that write is the real one.
   */
  where(): GrantLocation {
    const env = this.readEnvelope();
    if (env) return env.enc === "keychain" ? "keychain" : "file";
    return getSecretCipher() ? "keychain" : "file";
  }

  /** The non-secret view. Safe to serialize into an API response. */
  status(): SocialConnectionStatus {
    const grant = this.readSecret();
    if (!grant) return { connected: false, revoked: this.revoked(), scopes: [], where: this.where() };
    return {
      connected: true,
      // A grant that is here cannot be revoked, whatever a stale marker from
      // an older sign-in says. `write()` clears it, and this is the backstop.
      revoked: false,
      connectedAt: grant.connectedAt,
      scopes: grantedScopes(grant),
      where: this.where(),
    };
  }

  /**
   * The grant itself, tokens included. Callers: the adapter that signs a
   * provider request, and the refresh path. Never a route body.
   *
   * Self-healing: a plaintext envelope found while a cipher IS registered is
   * re-written encrypted. That covers the two ways one can exist on a
   * keychain-capable machine — a grant first written under `npx` and later
   * opened in the desktop app, and (historically) one written in the window
   * before the shell registered its cipher.
   */
  readSecret(): StoredGrant | null {
    const grant = this.decode();
    if (!grant) return null;
    // A test-mode grant belongs to the local fake and to nothing else. Serving
    // it outside test mode would hand the fake's bearer to the real provider.
    if (grant.testMode && !isTestMode()) {
      logger.debug(
        { tag: "social", op: "token_store.test_grant_ignored", providerId: this.providerId },
        "a test-mode grant is on disk but test mode is off; treating as absent",
      );
      return null;
    }
    return grant;
  }

  /** The envelope's contents, decrypted and healed. Says nothing about whether
   *  the grant is one this process may USE — that is `readSecret()`. */
  private decode(): StoredGrant | null {
    const env = this.readEnvelope();
    if (!env) return null;
    try {
      if (env.enc === "none") {
        // Healing is a write, so it may read the keychain — but only when a
        // grant is on disk to heal, never on a machine that has none.
        const cipher = cipherForWrite();
        if (cipher) this.reencrypt(env.grant, cipher);
        return env.grant;
      }
      const cipher = getSecretCipher();
      if (!cipher) {
        logger.warn(
          { tag: "social", op: "token_store.no_cipher", providerId: this.providerId },
          "encrypted grant but no cipher registered; treating as absent",
        );
        return null;
      }
      return JSON.parse(cipher.decrypt(Buffer.from(env.blob, "base64"))) as StoredGrant;
    } catch (err) {
      logger.warn(
        { tag: "social", op: "token_store.decrypt_failed", providerId: this.providerId, ...errShape(err) },
        "grant could not be decrypted",
      );
      return null;
    }
  }

  write(grant: StoredGrant): void {
    const cipher = cipherForWrite();
    const env: Envelope = cipher
      ? { v: 1, enc: "keychain", blob: cipher.encrypt(JSON.stringify(grant)).toString("base64") }
      : { v: 1, enc: "none", grant };
    this.writeEnvelope(env);
    // A completed sign-in un-revokes: the marker outlives the grant it was
    // written for, and must not survive the one that replaces it. A TEST-MODE
    // grant is not a sign-in, so it must not erase the evidence of a real
    // revocation it happens to be sitting on top of — a run of
    // `LIBI_TEST_MODE=1` over a real `~/.libi` would otherwise leave the user
    // back at "never connected" once test mode is off.
    if (!grant.testMode) this.markRevoked(false);
    logger.info(
      { tag: "social", op: "token_store.write", providerId: this.providerId, where: this.where() },
      "grant stored",
    );
  }

  /**
   * Remove the grant. `reason` is REQUIRED so every call site has to decide
   * which of the two the user is looking at afterwards — a revoked grant that
   * reported itself as "never connected" is the defect this parameter exists
   * to make un-writable.
   */
  clear(reason: GrantClearReason): void {
    try { fs.rmSync(this.path(), { force: true }); } catch { /* already gone */ }
    // A write that crashed between create and rename leaves a temp file
    // holding a COMPLETE grant. Removing only the final name would leave the
    // credential on disk forever, invisible to both the user and `status()`.
    for (const stray of this.strayTemps()) {
      try { fs.rmSync(stray, { force: true }); } catch { /* raced with another writer */ }
    }
    this.markRevoked(reason === "revoked");
    logger.info(
      { tag: "social", op: "token_store.clear", providerId: this.providerId, reason },
      "grant removed",
    );
  }

  private readEnvelope(): Envelope | null {
    try {
      if (!fs.existsSync(this.path())) return null;
      return JSON.parse(fs.readFileSync(this.path(), "utf8")) as Envelope;
    } catch (err) {
      logger.warn(
        { tag: "social", op: "token_store.read_failed", providerId: this.providerId, ...errShape(err) },
        "grant file unreadable",
      );
      return null;
    }
  }

  /**
   * Atomic-ish replace. The temp name is RANDOM and created with `wx`:
   * a fixed `<file>.tmp` is a name an attacker (or a crashed previous write)
   * can pre-create, and `writeFileSync` onto an existing path keeps that
   * file's mode and follows a symlink — so the grant could land world-readable
   * or outside `<LIBI_HOME>` entirely. `wx` fails instead of doing either.
   */
  private writeEnvelope(env: Envelope): void {
    const dir = this.dir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodBestEffort(dir, 0o700, "chmod_social_dir");
    const tmp = `${this.path()}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600, flag: "wx" });
      // Before the rename: the umask masks `mode` at creation, and after the
      // rename the window where the real file is readable has already opened.
      chmodBestEffort(tmp, 0o600, "chmod_social_grant");
      fs.renameSync(tmp, this.path());
    } finally {
      // Succeeded → the rename consumed it. Failed → a partial grant is sitting
      // there; take it with us rather than leaving it for `clear()` to find.
      if (fs.existsSync(tmp)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      }
    }
  }

  /** Re-write a plaintext grant encrypted. Never fails a read. */
  private reencrypt(grant: StoredGrant, cipher: SecretCipher): void {
    try {
      this.writeEnvelope({
        v: 1,
        enc: "keychain",
        blob: cipher.encrypt(JSON.stringify(grant)).toString("base64"),
      });
      logger.info(
        { tag: "social", op: "token_store.reencrypted", providerId: this.providerId },
        "plaintext grant re-written into the keychain envelope",
      );
    } catch (err) {
      logger.warn(
        { tag: "social", op: "token_store.reencrypt_failed", providerId: this.providerId, ...errShape(err) },
        "could not re-encrypt a plaintext grant; leaving it as-is",
      );
    }
  }

  /** Temp files from crashed writes for THIS provider (incl. the old fixed `.tmp`). */
  private strayTemps(): string[] {
    const prefix = `${path.basename(this.path())}.`;
    try {
      return fs
        .readdirSync(this.dir())
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map((name) => path.join(this.dir(), name));
    } catch {
      return [];
    }
  }
}
