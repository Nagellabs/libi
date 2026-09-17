import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `createAggregateSession` wires libi's own `McpServer` to an in-process
 * `InMemoryTransport` pair in two steps — `libi.connect(serverT)` then
 * `libiClient.connect(clientT)`. If the SECOND one throws after the first
 * succeeded, the server half stays connected with nobody holding a reference
 * to close it: one leaked `McpServer` (and its transport) per failed session
 * open, on a path a client can retry freely.
 *
 * Both halves are mocked here because neither is otherwise injectable, and a
 * real `Client.connect` can only be made to fail by hanging (its handshake
 * timeout is 60s, which is not a unit test).
 */
const serverClose = vi.fn(async () => {});
const serverConnect = vi.fn(async () => {});
const clientClose = vi.fn(async () => {});
const clientConnect = vi.fn(async () => {
  throw new Error("client handshake refused");
});

vi.mock("@/mcp/server", () => ({
  createLibiMcpServer: () => ({ connect: serverConnect, close: serverClose }),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = clientConnect;
    close = clientClose;
  },
}));

import { createAggregateSession } from "@/mcp/http/session";

describe("createAggregateSession — a failed in-process connect leaks nothing", () => {
  beforeEach(() => {
    serverClose.mockClear();
    serverConnect.mockClear();
    clientClose.mockClear();
    clientConnect.mockClear();
  });

  it("closes libi's McpServer when the in-memory client fails to connect", async () => {
    await expect(
      createAggregateSession({ surface: "cli", dialect: "claude", instructions: "HI" }),
    ).rejects.toThrow("client handshake refused");
    expect(serverConnect).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(clientClose).toHaveBeenCalledTimes(1);
  });
});
