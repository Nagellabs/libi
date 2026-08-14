import { describe, it, expect } from "vitest";
import { isAllowedWsOrigin } from "@/lib/terminal/ws-server";

describe("isAllowedWsOrigin", () => {
  it("allows a missing Origin (non-browser CLI client)", () => {
    expect(isAllowedWsOrigin(null)).toBe(true);
  });

  it("allows a loopback Origin on any port", () => {
    expect(isAllowedWsOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedWsOrigin("http://localhost:9999")).toBe(true);
    expect(isAllowedWsOrigin("http://[::1]:3000")).toBe(true);
    // Loopback host on a different port than the server is still same-machine.
    expect(isAllowedWsOrigin("http://127.0.0.1:8080")).toBe(true);
  });

  it("rejects a foreign / DNS-rebinding Origin", () => {
    expect(isAllowedWsOrigin("https://rebind.attacker.example")).toBe(false);
    expect(isAllowedWsOrigin("http://192.168.1.5:3000")).toBe(false);
    expect(isAllowedWsOrigin("https://evil.example")).toBe(false);
  });

  it("rejects the literal string \"null\" (file:// / sandboxed page)", () => {
    expect(isAllowedWsOrigin("null")).toBe(false);
  });

  it("rejects a malformed Origin", () => {
    expect(isAllowedWsOrigin("not a url")).toBe(false);
    expect(isAllowedWsOrigin("")).toBe(false);
  });
});
