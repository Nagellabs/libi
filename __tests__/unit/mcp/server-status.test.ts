import { describe, it, expect } from "vitest";
import { nextServerStatus, type ServerStatus } from "@/mcp/registry/server-status";

describe("nextServerStatus", () => {
  it("starts → up on probe_success", () => {
    expect(nextServerStatus("starting", { type: "probe_success" })).toBe<ServerStatus>("up");
  });
  it("starts → down on probe_fail", () => {
    expect(nextServerStatus("starting", { type: "probe_fail" })).toBe<ServerStatus>("down");
  });
  it("up → starting on retry", () => {
    expect(nextServerStatus("up", { type: "retry" })).toBe<ServerStatus>("starting");
  });
  it("down → starting on retry", () => {
    expect(nextServerStatus("down", { type: "retry" })).toBe<ServerStatus>("starting");
  });
  it("any → unknown on reset", () => {
    expect(nextServerStatus("up", { type: "reset" })).toBe<ServerStatus>("unknown");
    expect(nextServerStatus("down", { type: "reset" })).toBe<ServerStatus>("unknown");
  });
  it("ignores invalid transitions", () => {
    expect(nextServerStatus("up", { type: "probe_success" })).toBe<ServerStatus>("up");
  });
});
