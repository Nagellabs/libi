import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

describe("libi-tracking MCP spawn", () => {
  it("starts via tsx and responds to MCP initialize over stdio", async () => {
    const root = process.cwd();
    const tsx = join(root, "node_modules", ".bin", "tsx");
    const child = spawn(tsx, ["--tsconfig", join(root, "tsconfig.json"), join(root, "mcp", "tracking-mcp", "index.ts")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n";
    let out = "";
    let err = "";
    const done = new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout; stderr=" + err.slice(-800))); }, 30_000);
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.stdout.on("data", (d) => {
        out += d.toString();
        if (out.includes('"id":1') && out.includes("result")) { clearTimeout(to); child.kill("SIGKILL"); resolve(); }
      });
      child.on("error", reject);
    });
    child.stdin.write(init);
    await done;
    expect(out).toContain('"result"');
  }, 40_000);
});
