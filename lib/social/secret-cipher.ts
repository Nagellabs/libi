import { serverLogger as logger } from "@/lib/logger";

/**
 * The desktop shell's keychain-backed cipher (Electron `safeStorage`: the key
 * lives in the OS keychain, the blob in our file). Registered by the shell
 * through `lib/runtime/shell-api.ts#registerSecretCipher`; under `npx` nothing
 * registers and the token store falls back to a plain 0600 file. Global so a
 * runtime loaded once by the shell shares it with every route.
 *
 * IN-PROCESS ONLY. The registry lives on `globalThis`, so it reaches exactly
 * the routes running inside the shell's own process. The out-of-process
 * children — above all `serve-mcp-http` (`mcp/http/`), which the supervisor
 * spawns as a separate node process — never receive one, so a grant encrypted
 * by the desktop app reads there as "not connected" rather than as a token.
 * That is the intended failure shape: the aggregator has no business holding
 * libi's OAuth grant, and it must go through an HTTP route that does.
 */
export interface SecretCipher {
  label: "keychain";
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

const g = globalThis as unknown as { __libiSecretCipher?: SecretCipher | null };

/**
 * Publish (or, with `null`, withdraw) the process-wide cipher.
 *
 * Replacing a cipher that is already registered is never expected in a real
 * launch — the shell registers exactly once, before the Next server binds —
 * and it silently changes how every subsequent write is encoded (a withdrawal
 * to `null` turns the next write into plaintext), so any change away from an
 * already-registered cipher is logged.
 */
export function registerSecretCipher(c: SecretCipher | null): void {
  const previous = g.__libiSecretCipher ?? null;
  if (previous && previous !== c) {
    logger.warn(
      { tag: "social", op: "secret_cipher.replaced", had: previous.label, next: c ? c.label : null },
      "a secret cipher was already registered; replacing it",
    );
  }
  g.__libiSecretCipher = c;
}

export function getSecretCipher(): SecretCipher | null {
  return g.__libiSecretCipher ?? null;
}
