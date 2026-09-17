/**
 * The port every URL this process hands out names (`getLiveMcpPort`).
 *
 * With a supervisor in the process it must be that supervisor's own port in
 * every state. The file-and-default fallback is exactly what pointed in-app
 * agents at another libi instance: a supervisor that gave up drops
 * `mcp-port`, and the default behind it, 3457, is what the desktop app and
 * `npx` both prefer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getLiveMcpPort,
  getMcpHttpChild,
  getRegistrationMcpPort,
  setMcpHttpChild,
} from "@/lib/server/lifecycle/mcp-http-handle";
import { DEFAULT_MCP_PORT } from "@/lib/libi-home";
import type { McpHttpChildHandle } from "@/lib/server/lifecycle/mcp-http-child";

function fakeHandle(over: Partial<McpHttpChildHandle> = {}): McpHttpChildHandle {
  return {
    port: 3501,
    advertisedPort: 3501,
    publishedPort: 3501,
    ownsHealthAnswer: () => true,
    stop: async () => {},
    restart: async () => {},
    status: () => "gave-up",
    ...over,
  };
}

describe("getLiveMcpPort", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevPort: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mcp-handle-"));
    prevHome = process.env.LIBI_HOME;
    prevPort = process.env.LIBI_MCP_PORT;
    process.env.LIBI_HOME = home;
    delete process.env.LIBI_MCP_PORT;
  });

  afterEach(() => {
    setMcpHttpChild(null);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    if (prevPort === undefined) delete process.env.LIBI_MCP_PORT;
    else process.env.LIBI_MCP_PORT = prevPort;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("with a supervisor in this process, names its advertised port in every state, never the mcp-port file or the default", () => {
    // What another instance sharing this home, or the default, would say.
    fs.writeFileSync(path.join(home, "mcp-port"), String(DEFAULT_MCP_PORT));
    for (const status of ["gave-up", "restarting", "stopped", "running"] as const) {
      setMcpHttpChild(fakeHandle({ status: () => status }));
      expect(getLiveMcpPort()).toBe(3501);
    }
    // Mid-relaunch on a moved port, URLs keep the published one.
    setMcpHttpChild(fakeHandle({ port: 4001, advertisedPort: 3999, status: () => "running" }));
    expect(getLiveMcpPort()).toBe(3999);
  });

  it("judges a registration against the port `libi connect` would write while a first launch gave up with nothing published, and against the live port otherwise", () => {
    // The first launch gave up on a fallback it moved to while the default was busy.
    setMcpHttpChild(fakeHandle({ port: 3501, advertisedPort: 3501, publishedPort: null, status: () => "gave-up" }));
    expect(getLiveMcpPort()).toBe(3501);
    expect(getRegistrationMcpPort()).toBe(DEFAULT_MCP_PORT);
    process.env.LIBI_MCP_PORT = "4555";
    expect(getRegistrationMcpPort()).toBe(4555);
    delete process.env.LIBI_MCP_PORT;
    // A restart from there is still picking: nothing published yet either.
    setMcpHttpChild(fakeHandle({ port: 3501, advertisedPort: 3501, publishedPort: null, status: () => "restarting" }));
    expect(getRegistrationMcpPort()).toBe(DEFAULT_MCP_PORT);

    // Still inside the first health window: the picked port is the live one.
    setMcpHttpChild(fakeHandle({ port: 3501, advertisedPort: 3501, publishedPort: null, status: () => "running" }));
    expect(getRegistrationMcpPort()).toBe(3501);
    // Once something was published, registrations name that, in every state.
    for (const status of ["gave-up", "restarting", "stopped", "running"] as const) {
      setMcpHttpChild(fakeHandle({ port: 4001, advertisedPort: 3999, publishedPort: 3999, status: () => status }));
      expect(getRegistrationMcpPort()).toBe(3999);
    }
    setMcpHttpChild(null);
    fs.writeFileSync(path.join(home, "mcp-port"), "3999");
    expect(getRegistrationMcpPort()).toBe(3999);
  });

  it("with no supervisor (an MCP child process), reads the mcp-port file, then the resolver", () => {
    expect(getLiveMcpPort()).toBe(DEFAULT_MCP_PORT);
    fs.writeFileSync(path.join(home, "mcp-port"), "3999");
    expect(getLiveMcpPort()).toBe(3999);
  });

  it("is one slot for every module instance, so a route bundled apart from the lifecycle still finds the handle", async () => {
    const handle = fakeHandle();
    setMcpHttpChild(handle);
    vi.resetModules();
    const reimported = await import("@/lib/server/lifecycle/mcp-http-handle");
    expect(reimported.getMcpHttpChild()).toBe(handle);
    expect(getMcpHttpChild()).toBe(handle);
  });
});
