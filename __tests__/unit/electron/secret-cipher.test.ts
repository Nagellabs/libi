import { describe, it, expect, vi } from "vitest";
import { createKeychainCipher, type SafeStorageLike } from "../../../electron/secret-cipher";

/**
 * On macOS `safeStorage.isEncryptionAvailable()` READS the keychain, and a read
 * whose item doesn't list the running build is a login-password prompt. 0.1.16
 * asked it at every launch (owner report 2026-09-29: a keychain prompt each
 * time the installed app opened, with no social grant stored at all). The
 * cipher must therefore cost nothing until a grant is written or read.
 */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
    decryptString: vi.fn((blob: Buffer) => blob.toString().replace(/^enc:/, "")),
  } satisfies SafeStorageLike;
}

describe("electron/secret-cipher: the keychain is read on first use, never at registration", () => {
  it("creating the cipher touches nothing in safeStorage and logs nothing", () => {
    const ss = fakeSafeStorage();
    const log = vi.fn();
    const c = createKeychainCipher(ss, log);
    expect(c.label).toBe("keychain");
    expect(ss.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(ss.encryptString).not.toHaveBeenCalled();
    expect(ss.decryptString).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("asks availability once, remembers it, and logs the answer once", () => {
    const ss = fakeSafeStorage();
    const log = vi.fn();
    const c = createKeychainCipher(ss, log);
    expect(c.available()).toBe(true);
    expect(c.available()).toBe(true);
    c.encrypt("a");
    c.encrypt("b");
    expect(ss.isEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/keychain available/));
  });

  it("round-trips through safeStorage", () => {
    const c = createKeychainCipher(fakeSafeStorage(), vi.fn());
    expect(c.decrypt(c.encrypt("grant"))).toBe("grant");
  });

  it("with encryption unavailable, encrypt refuses rather than return something that is not ciphertext", () => {
    const ss = fakeSafeStorage(false);
    const log = vi.fn();
    const c = createKeychainCipher(ss, log);
    expect(c.available()).toBe(false);
    expect(() => c.encrypt("grant")).toThrow(/unavailable/);
    expect(ss.encryptString).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/UNAVAILABLE/));
  });

  it("decrypting an existing grant does not first ask availability", () => {
    const ss = fakeSafeStorage();
    const c = createKeychainCipher(ss, vi.fn());
    c.decrypt(Buffer.from("enc:x"));
    expect(ss.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(ss.decryptString).toHaveBeenCalledTimes(1);
  });
});
