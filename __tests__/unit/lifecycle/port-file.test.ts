/**
 * Defect D1: the packaged app binds an EPHEMERAL port but published a
 * hardcoded "3456" into `<LIBI_HOME>/port` — the file every MCP child, job
 * callback and render page resolves the server through. On the gate machine
 * that port belonged to a DIFFERENT libi instance, so an MCP child read and
 * wrote the wrong database.
 */
import { describe, it, expect } from "vitest";
import { resolvePortToPublish } from "@/lib/server/lifecycle/category-b";

describe("resolvePortToPublish", () => {
  it("prefers PORT — the variable both server entry points set from the REAL bound port", () => {
    expect(resolvePortToPublish({ PORT: "64988" })).toEqual({
      port: "64988",
      source: "PORT",
    });
  });

  it("falls back to LIBI_PORT when PORT is unset", () => {
    expect(resolvePortToPublish({ LIBI_PORT: "3470" })).toEqual({
      port: "3470",
      source: "LIBI_PORT",
    });
  });

  it("PORT wins over LIBI_PORT", () => {
    expect(resolvePortToPublish({ PORT: "1", LIBI_PORT: "2" }).port).toBe("1");
  });

  it("reports the hardcoded default as source 'default' so it can be logged, not written silently", () => {
    // Silently writing this value is exactly the shipped bug: the file looked
    // healthy while pointing at a server this process was not listening on.
    expect(resolvePortToPublish({})).toEqual({ port: "3456", source: "default" });
  });
});
