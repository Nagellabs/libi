import { describe, it, expect } from "vitest";
import {
  CDP_PORT_BASE,
  PORT_RANGE_SIZE,
  PORT_RANGE_START,
  TERMINAL_WS_PORT_BASE,
  terminalWsPortForNextPort,
} from "@/lib/dev/worktree-bootstrap";
import { resolveTerminalWsPort } from "@/lib/terminal/ws-server";

describe("terminal ws port selection (worktree dev routing)", () => {
  it("derives 1:1 from the Next port like the CDP port", () => {
    expect(terminalWsPortForNextPort(PORT_RANGE_START)).toBe(TERMINAL_WS_PORT_BASE);
    expect(terminalWsPortForNextPort(PORT_RANGE_START + 7)).toBe(
      TERMINAL_WS_PORT_BASE + 7,
    );
  });

  it("keeps the derived range clear of the CDP port block", () => {
    const cdpEnd = CDP_PORT_BASE + PORT_RANGE_SIZE - 1;
    expect(TERMINAL_WS_PORT_BASE).toBeGreaterThan(cdpEnd);
  });

  it("gives distinct ports to distinct worktree Next ports", () => {
    const ports = new Set<number>();
    for (let i = 0; i < PORT_RANGE_SIZE; i++) {
      ports.add(terminalWsPortForNextPort(PORT_RANGE_START + i));
    }
    expect(ports.size).toBe(PORT_RANGE_SIZE);
  });

  it("honors the LIBI_TERMINAL_WS_PORT env override first", () => {
    expect(
      resolveTerminalWsPort({ LIBI_TERMINAL_WS_PORT: "9500" }, PORT_RANGE_START),
    ).toBe(9500);
  });

  it("derives from the Next port inside the dev range", () => {
    expect(resolveTerminalWsPort({}, PORT_RANGE_START + 3)).toBe(
      TERMINAL_WS_PORT_BASE + 3,
    );
  });

  it("falls back to ephemeral outside the dev range (packaged production)", () => {
    expect(resolveTerminalWsPort({}, 54321)).toBe(0);
    expect(resolveTerminalWsPort({}, PORT_RANGE_START + PORT_RANGE_SIZE)).toBe(0);
    expect(resolveTerminalWsPort({}, null)).toBe(0);
  });

  it("ignores a malformed env override", () => {
    expect(resolveTerminalWsPort({ LIBI_TERMINAL_WS_PORT: "abc" }, null)).toBe(0);
  });
});
