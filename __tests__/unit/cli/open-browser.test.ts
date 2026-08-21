// `npx @nagellabs/libi` hands the studio to the user's browser instead of
// leaving a URL to copy. What these tests pin down is the part that can go
// wrong quietly:
//
//   - WHEN we open (a dev checkout must not pop a browser on every
//     `npm run dev`; CI has no desktop; `--connect-agent` is headless by
//     definition) — and that an explicit flag always wins;
//   - WHAT we hand the OS: only libi's own loopback URL, never a shell;
//   - that a failed launch is one honest line, never an error;
//   - that readiness means THIS libi answered, not merely that something is
//     listening on the port.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  browserOpenCommand,
  isLoopbackStudioUrl,
  openStudioInBrowser,
  openStudioUrl,
  openStudioWhenReady,
  shouldOpenBrowser,
  waitForStudio,
} from "@/lib/cli/open-browser";

describe("shouldOpenBrowser", () => {
  it("defaults ON for an installed libi and OFF in a dev checkout", () => {
    expect(shouldOpenBrowser({ isDevCheckout: false, env: {} })).toBe(true);
    expect(shouldOpenBrowser({ isDevCheckout: true, env: {} })).toBe(false);
  });

  it("lets an explicit flag win over every default", () => {
    expect(shouldOpenBrowser({ flag: false, isDevCheckout: false, env: {} })).toBe(false);
    expect(shouldOpenBrowser({ flag: true, isDevCheckout: true, env: { CI: "1" } })).toBe(true);
    // Even connect-agent, whose whole point is headless — the user asked.
    expect(
      shouldOpenBrowser({ flag: true, isDevCheckout: false, connectAgent: true, env: {} }),
    ).toBe(true);
  });

  it("honours LIBI_OPEN in both directions, below the flag", () => {
    expect(shouldOpenBrowser({ isDevCheckout: true, env: { LIBI_OPEN: "1" } })).toBe(true);
    expect(shouldOpenBrowser({ isDevCheckout: true, env: { LIBI_OPEN: "yes" } })).toBe(true);
    expect(shouldOpenBrowser({ isDevCheckout: false, env: { LIBI_OPEN: "0" } })).toBe(false);
    expect(shouldOpenBrowser({ isDevCheckout: false, env: { LIBI_OPEN: "false" } })).toBe(false);
    expect(shouldOpenBrowser({ flag: true, isDevCheckout: false, env: { LIBI_OPEN: "0" } })).toBe(
      true,
    );
    // Junk is not a vote — fall through to the default rather than guessing.
    expect(shouldOpenBrowser({ isDevCheckout: false, env: { LIBI_OPEN: "maybe" } })).toBe(true);
  });

  it("stays out of the way for connect-agent and CI", () => {
    expect(shouldOpenBrowser({ isDevCheckout: false, connectAgent: true, env: {} })).toBe(false);
    expect(shouldOpenBrowser({ isDevCheckout: false, env: { CI: "true" } })).toBe(false);
    // `CI=0`/`CI=false` is how a runner says "not CI" — it must not disable it.
    expect(shouldOpenBrowser({ isDevCheckout: false, env: { CI: "0" } })).toBe(true);
    expect(shouldOpenBrowser({ isDevCheckout: false, env: { CI: "" } })).toBe(true);
  });
});

describe("browserOpenCommand", () => {
  it("uses the platform's opener, always via argv (never a shell)", () => {
    expect(browserOpenCommand("darwin", "http://localhost:3456")).toEqual({
      command: "open",
      args: ["http://localhost:3456"],
    });
    // The empty string is `start`'s window TITLE — drop it and the URL is
    // consumed as the title and nothing opens.
    expect(browserOpenCommand("win32", "http://localhost:3456")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://localhost:3456"],
    });
    expect(browserOpenCommand("linux", "http://localhost:3456")).toEqual({
      command: "xdg-open",
      args: ["http://localhost:3456"],
    });
  });

  it("accepts only libi's own loopback URL", () => {
    expect(isLoopbackStudioUrl("http://localhost:3456")).toBe(true);
    expect(isLoopbackStudioUrl("http://127.0.0.1:3456/api/runtime")).toBe(true);
    expect(isLoopbackStudioUrl("https://example.com")).toBe(false);
    expect(isLoopbackStudioUrl("http://localhost.evil.com:3456")).toBe(false);
    expect(isLoopbackStudioUrl("file:///etc/passwd")).toBe(false);
  });

  it("refuses anything else — this is the only gate before an OS handoff", () => {
    for (const url of [
      "https://example.com",
      "http://localhost:3456 & calc.exe",
      'http://localhost:3456" "https://example.com',
      "http://evil.com/#http://localhost:3456",
    ]) {
      expect(browserOpenCommand("win32", url)).toBeNull();
      expect(browserOpenCommand("darwin", url)).toBeNull();
    }
  });
});

/** A stand-in for the spawned launcher: an EventEmitter the test drives. */
function fakeChild(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}

describe("openStudioUrl", () => {
  it("reports success when the launcher exits cleanly", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const promise = openStudioUrl("http://localhost:3456", {
      platform: "darwin",
      spawnImpl,
    });
    child.emit("exit", 0);
    await expect(promise).resolves.toEqual({ opened: true });
    expect(spawnImpl).toHaveBeenCalledWith(
      "open",
      ["http://localhost:3456"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("reports the reason when the launcher is missing (no xdg-open)", async () => {
    const child = fakeChild();
    const promise = openStudioUrl("http://localhost:3456", {
      platform: "linux",
      spawnImpl: (() => child) as never,
    });
    child.emit("error", new Error("spawn xdg-open ENOENT"));
    const result = await promise;
    expect(result.opened).toBe(false);
    expect(result.reason).toContain("xdg-open");
    expect(result.reason).toContain("ENOENT");
  });

  it("reports the reason when the launcher exits non-zero", async () => {
    const child = fakeChild();
    const promise = openStudioUrl("http://localhost:3456", {
      platform: "darwin",
      spawnImpl: (() => child) as never,
    });
    child.emit("exit", 1);
    await expect(promise).resolves.toEqual({
      opened: false,
      reason: "open exited with code 1",
    });
  });

  it("counts a still-running launcher as opened — that's a foreground browser, not a failure", async () => {
    const child = fakeChild();
    const result = await openStudioUrl("http://localhost:3456", {
      platform: "linux",
      spawnImpl: (() => child) as never,
      timeoutMs: 5,
    });
    expect(result).toEqual({ opened: true });
    // Left alive deliberately: the user is looking at it.
    expect(child.unref).toHaveBeenCalled();
  });

  it("never spawns anything for a URL that isn't libi's", async () => {
    const spawnImpl = vi.fn();
    await expect(
      openStudioUrl("https://example.com", { platform: "darwin", spawnImpl: spawnImpl as never }),
    ).resolves.toEqual({ opened: false, reason: "refused to open https://example.com" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("survives a spawn that throws synchronously", async () => {
    const result = await openStudioUrl("http://localhost:3456", {
      platform: "darwin",
      spawnImpl: (() => {
        throw new Error("EMFILE");
      }) as never,
    });
    expect(result.opened).toBe(false);
    expect(result.reason).toContain("EMFILE");
  });
});

/** Serve `body` at `/api/runtime` and hand back its loopback base URL. */
async function serveRuntime(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("waitForStudio", () => {
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!();
  });

  it("resolves once libi answers /api/runtime, retrying until it does", async () => {
    let hits = 0;
    const { url, close } = await serveRuntime((req, res) => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(503).end("starting");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ worktreeName: null }));
    });
    servers.push(close);

    await expect(
      waitForStudio(url, { timeoutMs: 5_000, intervalMs: 5 }),
    ).resolves.toBe(true);
    expect(hits).toBe(3);
  });

  it("does NOT accept a foreign server holding the port — a 200 is not enough", async () => {
    const { url, close } = await serveRuntime((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>someone else's dev server</html>");
    });
    servers.push(close);

    await expect(waitForStudio(url, { timeoutMs: 120, intervalMs: 10 })).resolves.toBe(false);
  });

  it("gives up rather than hanging when nothing is listening", async () => {
    // Port 1 on loopback: connection refused, immediately, everywhere.
    await expect(
      waitForStudio("http://127.0.0.1:1", { timeoutMs: 100, intervalMs: 10 }),
    ).resolves.toBe(false);
  });
});

describe("what the user is told", () => {
  it("says nothing extra when the browser opened — the URL was printed at boot", async () => {
    const child = fakeChild();
    const write = vi.fn();
    const promise = openStudioInBrowser("http://localhost:3456", {
      platform: "darwin",
      spawnImpl: (() => child) as never,
      write,
    });
    child.emit("exit", 0);
    await promise;
    expect(write).not.toHaveBeenCalled();
  });

  it("repeats the URL, with the reason, when the launch failed", async () => {
    const child = fakeChild();
    const write = vi.fn();
    const promise = openStudioInBrowser("http://localhost:3456", {
      platform: "linux",
      spawnImpl: (() => child) as never,
      write,
    });
    child.emit("error", new Error("spawn xdg-open ENOENT"));
    await promise;

    const printed = write.mock.calls.map((c) => c[0]).join("");
    expect(printed).toContain("http://localhost:3456");
    expect(printed).toContain("xdg-open");
    // An unopened browser is never framed as a broken studio.
    expect(printed.toLowerCase()).not.toContain("error");
    expect(printed.toLowerCase()).not.toContain("failed");
  });

  it("points the user at the URL instead of hanging when the studio never answers", async () => {
    const write = vi.fn();
    const spawnImpl = vi.fn();
    const result = await openStudioWhenReady("http://127.0.0.1:1", {
      timeoutMs: 60,
      intervalMs: 10,
      write,
      spawnImpl: spawnImpl as never,
    });

    expect(result.opened).toBe(false);
    expect(write.mock.calls.map((c) => c[0]).join("")).toContain("http://127.0.0.1:1");
    // No browser is launched at a server that isn't there.
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
