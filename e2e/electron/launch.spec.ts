import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchLibi } from "./helpers";

/**
 * The LIBI_HOME the shell under test boots against — the same resolution
 * `lib/libi-home.ts#getLibiHome` uses, minus the `config.json` override
 * (the harness always sets LIBI_HOME explicitly; see the spec below).
 */
const LIBI_HOME = process.env.LIBI_HOME ?? path.join(os.homedir(), ".libi");
const MCP_PORT_FILE = path.join(LIBI_HOME, "mcp-port");

interface HealthzBody {
  ok: boolean;
  version: string;
  port: number;
  sessions: number;
}

/**
 * Wait for `<LIBI_HOME>/mcp-port` to hold a parseable port.
 *
 * The studio binds its HTTP listener BEFORE Category B runs (bind-then-prepare,
 * `lib/server/next-server.ts`), and the aggregator's port file is published only
 * after its `/healthz` passes (`lib/server/lifecycle/mcp-http-child.ts`) — so a
 * loaded main window is no proof the file is there yet. Poll rather than read
 * once.
 */
async function waitForMcpPort(timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = fs.readFileSync(MCP_PORT_FILE, "utf-8").trim();
      const parsed = Number.parseInt(last, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
    } catch {
      /* not published yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `${MCP_PORT_FILE} did not hold a port within ${timeoutMs}ms (last read: ${JSON.stringify(last)})`,
  );
}

test.describe("Electron — basic launch + page health", () => {
  test("main window loads the editor without page errors", async () => {
    const { app, main } = await launchLibi();
    const pageErrors: string[] = [];
    main.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));

    try {
      await main.waitForLoadState("domcontentloaded", { timeout: 30_000 });

      // Sanity: we landed on the SPA, not a 404 / blank.
      expect(main.url()).toMatch(/127\.0\.0\.1|localhost/);
      const title = await main.title();
      expect(title.length).toBeGreaterThan(0);

      // The sidebar's brand link must render — proves the app shell
      // hydrated even before any data loads.
      const sidebarBrand = main.locator("[data-slot=sidebar-container]").first();
      await expect(sidebarBrand).toBeVisible({ timeout: 20_000 });

      // No uncaught page errors during initial load.
      expect(pageErrors, pageErrors.join("\n\n")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  /**
   * The HTTP MCP aggregator is what EVERY agent surface talks to (the in-app
   * agent and a `libi connect`-registered CLI share one entry), and the port
   * file is its only discovery mechanism. A desktop user never types a port,
   * so a shell that comes up without these two facts is a desktop app whose
   * agent has no tools — which is exactly why this assertion lives here and
   * not only in the unit/integration tiers.
   *
   * Deliberately NOT asserted: that `mcp-port` disappears once the app quits.
   * The aggregator belongs to the STUDIO process, not the shell — in dev
   * (`app.isPackaged === false`, which is what `_electron.launch(main.js)`
   * gives us) `startNextServer()` just reads LIBI_PORT and attaches to a
   * server the harness started, so quitting Electron leaves the studio, its
   * Category B lifecycle and its port file running. Shutdown cleanup is
   * covered where it is actually observable: `stop()` unlinking the port file
   * in `__tests__/unit/server/lifecycle/mcp-http-child.test.ts`.
   */
  test("booted shell publishes mcp-port and the aggregator answers /healthz", async () => {
    const { app } = await launchLibi();
    try {
      // ── 1. `<LIBI_HOME>/mcp-port` exists and holds an integer port.
      const port = await waitForMcpPort();
      expect(fs.existsSync(MCP_PORT_FILE)).toBe(true);
      expect(String(port)).toBe(fs.readFileSync(MCP_PORT_FILE, "utf-8").trim());
      // Never assume 3457: a second libi instance holding the default makes the
      // supervisor fall back to studio + 1, then to any free port.
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);

      // ── 2. /healthz answers 200 with the body mcp/http/server.ts writes.
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const health = (await res.json()) as HealthzBody;
      expect(health.ok).toBe(true);
      // The aggregator reports the port it bound; it must be the one published.
      expect(health.port).toBe(port);
      expect(typeof health.version).toBe("string");
      expect(health.version.length).toBeGreaterThan(0);
      expect(typeof health.sessions).toBe("number");
      // /healthz reports libi's own endpoint only — the aggregator proxies nothing.
      expect(health).not.toHaveProperty("upstreams");
      expect(health).not.toHaveProperty("upstreamsReady");

      // ── 3. The endpoint actually serves libi's own tools. `/healthz` carries
      // no tool count, so this is the check that would catch an aggregator
      // that is listening but serving nothing.
      const client = new Client({ name: "electron-e2e", version: "0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const libiTools = tools.filter((t) => t.name.startsWith("libi."));
        expect(
          libiTools.length,
          `no libi.* tools in ${tools.length} advertised: ${tools.map((t) => t.name).join(", ")}`,
        ).toBeGreaterThan(0);
      } finally {
        // DELETE /mcp — leave no session behind on a live aggregator.
        await transport.terminateSession().catch(() => {});
        await transport.close().catch(() => {});
      }
    } finally {
      await app.close();
    }
  });
});
