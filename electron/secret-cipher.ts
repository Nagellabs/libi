// electron/secret-cipher.ts
//
// The keychain-backed cipher the shell hands the runtime for libi's own
// social-provider grant (lib/social/token-store.ts, via
// `runtime.api.registerSecretCipher`).
//
// LAZY, and that is the whole point of this module. On macOS
// `safeStorage.isEncryptionAvailable()` is not a capability probe: it fetches
// the "libi Safe Storage" key from the login keychain (creating it if absent).
// 0.1.16 called it at every launch, so every launch read the keychain — for
// users who never connected a social provider, who have nothing encrypted.
// When the item's access list doesn't name the running app (it was created by
// another build: a local QA pack signed differently, or a user who once
// answered "Deny"), macOS asks for the login keychain password on every
// launch, before the window is even up.
//
// So registering touches nothing. The keychain is read the first time a grant
// is actually written or read — the user connecting, or libi using a grant
// they already stored — and that answer is remembered for the process.

type Log = (line: string) => void;

/** The slice of Electron's `safeStorage` this needs (a fake in tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

/** Mirrors lib/social/secret-cipher.ts#SecretCipher — the shell may not import runtime code. */
export interface KeychainCipher {
  label: "keychain";
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

export function createKeychainCipher(safeStorage: SafeStorageLike, log: Log): KeychainCipher {
  let availability: boolean | undefined;
  const available = (): boolean => {
    if (availability === undefined) {
      availability = safeStorage.isEncryptionAvailable();
      // The ONLY signal that a packaged build is keeping the grant in a plain
      // file — `isEncryptionAvailable()` is false on a Linux box with no
      // keyring, and silence there is how we would never find out. No secret,
      // and nothing about the grant.
      log(
        availability
          ? "secret-cipher: OS keychain available; social grants are encrypted at rest"
          : "secret-cipher: safeStorage reports encryption UNAVAILABLE; social grants fall back to a private 0600 file",
      );
    }
    return availability;
  };
  return {
    label: "keychain",
    available,
    encrypt: (plain) => {
      // A runtime that predates `available()` calls encrypt directly; it must
      // never be handed a "ciphertext" safeStorage could not produce.
      if (!available()) throw new Error("OS keychain encryption is unavailable");
      return safeStorage.encryptString(plain);
    },
    decrypt: (blob) => safeStorage.decryptString(blob),
  };
}
