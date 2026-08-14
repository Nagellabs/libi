import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readInstallToken,
  writeInstallToken,
  isTokenCurrent,
} from "@/lib/uv-env/install-token";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-token-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("install-token helpers", () => {
  it("readInstallToken returns null when file missing", () => {
    expect(readInstallToken(".libi-test.install-token")).toBeNull();
  });

  it("writeInstallToken creates the file under LIBI_HOME with the signature", () => {
    writeInstallToken(".libi-test.install-token", "abc123");
    const onDisk = fs
      .readFileSync(path.join(tmp, ".libi-test.install-token"), "utf-8")
      .trim();
    expect(onDisk).toBe("abc123");
  });

  it("isTokenCurrent true when content matches", () => {
    writeInstallToken(".libi-test.install-token", "abc123");
    expect(isTokenCurrent(".libi-test.install-token", "abc123")).toBe(true);
  });

  it("isTokenCurrent false on mismatch", () => {
    writeInstallToken(".libi-test.install-token", "abc123");
    expect(isTokenCurrent(".libi-test.install-token", "def456")).toBe(false);
  });

  it("isTokenCurrent false when file absent", () => {
    expect(isTokenCurrent(".libi-test.install-token", "abc123")).toBe(false);
  });
});
