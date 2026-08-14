import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Pre-import the manifest so we can stub `getManagedBundledNpmMcps` indirectly
// via mocking the bundled registry. We DO NOT actually shell out to npm in
// these tests — for that we'd need an integration test with the real network.
vi.mock("@/mcp/registry/bundled", async () => {
  const actual = await vi.importActual<typeof import("@/mcp/registry/bundled")>(
    "@/mcp/registry/bundled",
  );
  return {
    ...actual,
    // Stub a single managed entry so the install logic has something to chew on.
    BUNDLED_MCP_SERVERS: [
      {
        id: "fake-managed",
        name: "Fake Managed",
        description: "",
        npmUrl: null,
        type: "stdio",
        command: "npx",
        args: ["-y", "@fake/pkg@1.2.3"],
        npmPackage: "@fake/pkg",
        pinnedVersion: "1.2.3",
        binName: "fake-bin",
        requireApproval: false,
        dependencies: [],
      },
    ],
  };
});

describe("bundled-install", () => {
  let prevHome: string | undefined;
  let root: string;

  beforeEach(async () => {
    prevHome = process.env.LIBI_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-install-test-"));
    process.env.LIBI_HOME = root;
    const { __resetBundledInstallForTests } = await import("@/lib/mcp/bundled-install");
    __resetBundledInstallForTests();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports `ready` and skips install when versions already match", async () => {
    // Pre-seed the install at the right version.
    fs.mkdirSync(path.join(root, "node_modules", "@fake", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@fake", "pkg", "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );

    const { ensureBundledNpmMcps, getBundledInstallSnapshot } = await import(
      "@/lib/mcp/bundled-install"
    );
    await ensureBundledNpmMcps();

    const snap = getBundledInstallSnapshot();
    expect(snap.status).toBe("ready");
    expect(snap.pkgs).toHaveLength(1);
    expect(snap.pkgs[0]).toMatchObject({
      id: "fake-managed",
      installedVersion: "1.2.3",
      pinnedVersion: "1.2.3",
      status: "ready",
    });
    // No package.json written because we short-circuited at the version check.
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(false);
  });

  it("returns the same promise when called concurrently (idempotent)", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "@fake", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@fake", "pkg", "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );

    const { ensureBundledNpmMcps } = await import("@/lib/mcp/bundled-install");
    const a = ensureBundledNpmMcps();
    const b = ensureBundledNpmMcps();
    await Promise.all([a, b]);

    // Both calls resolve; second was a no-op (we can't directly assert that,
    // but the snapshot must still reflect ready).
    const { getBundledInstallSnapshot } = await import("@/lib/mcp/bundled-install");
    expect(getBundledInstallSnapshot().status).toBe("ready");
  });

  it("detects drift when installed version differs from pinned", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "@fake", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@fake", "pkg", "package.json"),
      JSON.stringify({ version: "0.9.0" }),
    );

    // Replace `child_process.execFile` so we don't actually run npm — but we
    // need to leave a side-effect that LOOKS like an install completed.
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        // Simulate a successful npm install — upgrade the on-disk version.
        fs.writeFileSync(
          path.join(root, "node_modules", "@fake", "pkg", "package.json"),
          JSON.stringify({ version: "1.2.3" }),
        );
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    vi.resetModules();
    const { ensureBundledNpmMcps, getBundledInstallSnapshot } = await import(
      "@/lib/mcp/bundled-install"
    );
    await ensureBundledNpmMcps();

    const snap = getBundledInstallSnapshot();
    expect(snap.status).toBe("ready");
    expect(snap.pkgs[0]).toMatchObject({
      installedVersion: "1.2.3",
      status: "ready",
    });
    // package.json was written this time because we ran the install path.
    const writtenManifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    );
    expect(writtenManifest.dependencies["@fake/pkg"]).toBe("1.2.3");
  });

  it("passes --ignore-scripts to the npm install invocation (RC-E)", async () => {
    // Nothing installed on disk → status = "missing" → install path runs.
    let capturedArgs: string[] | null = null;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => {
        capturedArgs = args;
        // Simulate a successful install so verification passes.
        fs.mkdirSync(path.join(root, "node_modules", "@fake", "pkg"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "node_modules", "@fake", "pkg", "package.json"),
          JSON.stringify({ version: "1.2.3" }),
        );
        cb(null, { stdout: "", stderr: "" });
      },
    }));

    vi.resetModules();
    const { ensureBundledNpmMcps } = await import("@/lib/mcp/bundled-install");
    await ensureBundledNpmMcps();

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!).toContain("install");
    expect(capturedArgs!).toContain("--ignore-scripts");
  });

  it("flips to `failed` when npm install errors", async () => {
    // Nothing installed on disk → status = "missing"; we want install to fail.
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("npm exploded"));
      },
    }));

    vi.resetModules();
    const { ensureBundledNpmMcps, getBundledInstallSnapshot } = await import(
      "@/lib/mcp/bundled-install"
    );
    await ensureBundledNpmMcps();

    const snap = getBundledInstallSnapshot();
    expect(snap.status).toBe("failed");
    expect(snap.error).toContain("npm exploded");
  });

  it("emits progress callbacks for each phase", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "@fake", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@fake", "pkg", "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );

    const { ensureBundledNpmMcps } = await import("@/lib/mcp/bundled-install");
    const events: Array<{ phase: string; current: string | null }> = [];
    await ensureBundledNpmMcps((p) => events.push({ phase: p.phase, current: p.current }));

    // First event: checking, no current package.
    expect(events[0]).toEqual({ phase: "checking", current: null });
    // Hot path: no installing phase needed.
    expect(events.find((e) => e.phase === "installing")).toBeUndefined();
  });
});
