import { describe, it, expect } from "vitest";
import { sha256Hex } from "@/lib/sandbox/hash";

describe("sha256Hex", () => {
  it("hashes the body's UTF-8 bytes to 64 lowercase hex chars", async () => {
    // echo -n "abc" | shasum -a 256
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("hashes multi-byte UTF-8 by its bytes, not its code units", async () => {
    // printf '%s' 'héllo — 世界 🎬' | shasum -a 256   (22 bytes, 12 code points)
    expect(await sha256Hex("héllo — 世界 🎬")).toBe("31c8636fcc71c0027cf1fdd4610bcec5ba1f207ec111fe12f47bdbd376d16809");
  });
  it("is stable and content-keyed", async () => {
    expect(await sha256Hex("ctx.fillRect(0,0,1,1)")).toBe(await sha256Hex("ctx.fillRect(0,0,1,1)"));
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});
