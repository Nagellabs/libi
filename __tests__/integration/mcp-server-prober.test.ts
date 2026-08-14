import { describe, it, expect, vi, afterEach } from "vitest";
import path from "path";
import { probeMcpServer } from "@/mcp/registry/server-prober";
import { serverLogger } from "@/lib/logger";

describe("probeMcpServer", () => {
  it("returns up for a server that initializes successfully", async () => {
    const result = await probeMcpServer({
      command: "node",
      args: [path.resolve(__dirname, "../helpers/mcp-stub-ok.js")],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
    });
    expect(result.status).toBe("up");
    expect(result.error).toBeNull();
  });

  it("returns down when binary missing", async () => {
    const result = await probeMcpServer({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      env: { PATH: "/usr/bin" },
      timeoutMs: 2000,
    });
    expect(result.status).toBe("down");
    expect(result.error).toBeTruthy();
  });

  it("returns down when stub crashes on initialize", async () => {
    const result = await probeMcpServer({
      command: "node",
      args: [path.resolve(__dirname, "../helpers/mcp-stub-crash.js")],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
    });
    expect(result.status).toBe("down");
    expect(result.error).toContain("crash");
  });

  it("returns down on timeout", async () => {
    const result = await probeMcpServer({
      command: "node",
      args: [path.resolve(__dirname, "../helpers/mcp-stub-hang.js")],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 500,
    });
    expect(result.status).toBe("down");
    expect(result.error).toMatch(/timed out/i);
  });
});

/**
 * RC-F secret-leak-to-logs regression. A configured secret echoed in a failing
 * MCP child's stderr must NEVER reach `~/.libi/logs/libi.log`. `probeMcpServer`
 * logs only non-sensitive metadata (lengths, exit codes, booleans); the sole
 * place that logs the actual error TEXT is `probeAndPersist`, after it has run
 * `scrubSecrets`. These tests capture every `serverLogger` call `probeMcpServer`
 * emits and assert the sentinel is absent.
 */
describe("probeMcpServer secret-leak-to-logs (RC-F)", () => {
  const SENTINEL = "sk-LEAKSENTINEL-1234567890abcdef";

  // Capture the structured object passed to every serverLogger log call.
  function captureLogRecords(): { records: unknown[]; restore: () => void } {
    const records: unknown[] = [];
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    const spies = levels.map((lvl) =>
      vi.spyOn(serverLogger, lvl).mockImplementation(((obj: unknown) => {
        records.push(obj);
        return undefined as never;
      }) as never),
    );
    return { records, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not emit the stderr sentinel in any log record (exit-before-init path)", async () => {
    const { records, restore } = captureLogRecords();
    try {
      const result = await probeMcpServer({
        command: "node",
        args: [path.resolve(__dirname, "../helpers/mcp-stub-stderr-secret.js")],
        env: { PATH: process.env.PATH ?? "", LEAK_SENTINEL: SENTINEL },
        timeoutMs: 5000,
      });
      expect(result.status).toBe("down");
      // The returned error string legitimately carries stderr — it is scrubbed
      // by probeAndPersist, not here. What must be clean is the LOG stream.
      expect(result.error).toContain(SENTINEL);
    } finally {
      restore();
    }

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(SENTINEL);
    // And structurally: no log record from probeMcpServer carries a raw text
    // field that could hold child output.
    for (const rec of records as Array<Record<string, unknown>>) {
      expect(rec).not.toHaveProperty("stderr");
      expect(rec).not.toHaveProperty("text");
      expect(rec).not.toHaveProperty("line");
    }
  });

  it("does not emit the stderr sentinel in any log record (timeout path)", async () => {
    const { records, restore } = captureLogRecords();
    try {
      const result = await probeMcpServer({
        command: "node",
        args: [path.resolve(__dirname, "../helpers/mcp-stub-stderr-secret-hang.js")],
        env: { PATH: process.env.PATH ?? "", LEAK_SENTINEL: SENTINEL },
        timeoutMs: 500,
      });
      expect(result.status).toBe("down");
      expect(result.error).toMatch(/timed out/i);
    } finally {
      restore();
    }

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(SENTINEL);
    for (const rec of records as Array<Record<string, unknown>>) {
      expect(rec).not.toHaveProperty("stderr");
    }
  });
});
