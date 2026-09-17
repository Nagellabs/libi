import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The provider setup scripts are served as text for the "View <script>" links, and their folder is served to the
 * browser that builds the commands. The name route is read-only and serves exact allowlisted names only.
 */

let rootOverride: string | null = null;
vi.mock("@/lib/runtime/package-root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/package-root")>();
  return { ...actual, packageRoot: (fromDir?: string) => rootOverride ?? actual.packageRoot(fromDir) };
});
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  serverLogger: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET as getScript, dynamic as scriptDynamic } from "@/app/api/agents/setup-scripts/[name]/route";
import { GET as getFolder, dynamic as folderDynamic } from "@/app/api/agents/setup-scripts/route";
import { SETUP_SCRIPT_NAMES } from "@/lib/agents/setup/commands";

const REPO = process.cwd();
const REPO_SCRIPTS = path.join(REPO, "lib", "agents", "setup", "scripts");

const get = (name: string) =>
  getScript(new Request(`http://127.0.0.1:3000/api/agents/setup-scripts/${encodeURIComponent(name)}`), {
    params: Promise.resolve({ name }),
  });

afterEach(() => {
  rootOverride = null;
  logError.mockReset();
});

describe("GET /api/agents/setup-scripts/[name]", () => {
  it.each(SETUP_SCRIPT_NAMES)("serves %s as plain text, never cached, byte for byte", async (name) => {
    const res = await get(name);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(readFileSync(path.join(REPO_SCRIPTS, name), "utf8"));
  });

  it.each([
    "package.json",
    "commands.ts",
    "scripts-dir.ts",
    "",
    ".",
    "..",
    "../commands.ts",
    "../../../../package.json",
    "..%2Fcommands.ts",
    "%2e%2e%2fcommands.ts",
    "..%252Fcommands.ts",
    "..\\commands.ts",
    "add-provider.sh/../../commands.ts",
    "./add-provider.sh",
    "/etc/passwd",
    "%2Fetc%2Fpasswd",
    "ADD-PROVIDER.SH",
    "add-provider",
    "add-provider.sh ",
    "add-provider.sh\u0000",
    "add-provider.sh%00",
    "add-provider.sh.bak",
  ])("404s %j: only an exact allowlisted name is served", async (name) => {
    const res = await get(name);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("Not found\n");
  });

  it("an allowlisted name whose file is missing from the install is a 404, not an error page", async () => {
    rootOverride = mkdtempSync(path.join(os.tmpdir(), "libi-setup-scripts-"));
    try {
      expect((await get("add-provider.sh")).status).toBe(404);
    } finally {
      rmSync(rootOverride, { recursive: true, force: true });
    }
  });

  it("only reads: neither route nor the folder module can start a process", () => {
    for (const rel of ["app/api/agents/setup-scripts/[name]/route.ts", "app/api/agents/setup-scripts/route.ts", "lib/agents/setup/scripts-dir.ts"]) {
      expect(readFileSync(path.join(REPO, rel), "utf8"), rel).not.toMatch(/child_process|node-pty|execa|cross-spawn|\bspawn\(|\bexec(?:Sync|File)?\(/);
    }
  });
});

describe("GET /api/agents/setup-scripts", () => {
  it("answers the absolute scripts folder of this install, which holds every allowlisted script and nothing else", async () => {
    const res = await getFolder();
    expect(res.status).toBe(200);
    const { dir } = (await res.json()) as { dir: string };
    expect(dir).toBe(REPO_SCRIPTS);
    expect(path.isAbsolute(dir)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([...SETUP_SCRIPT_NAMES].sort());
  });

  it("an install missing any script is an error that names no folder, and is logged", async () => {
    rootOverride = mkdtempSync(path.join(os.tmpdir(), "libi-setup-scripts-"));
    try {
      const dir = path.join(rootOverride, "lib", "agents", "setup", "scripts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "add-provider.sh"), "#!/bin/sh\n");
      const res = await getFolder();
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("dir");
      expect(body.error).toMatch(/missing/);
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "providers", op: "setup_scripts_missing", dir, missing: SETUP_SCRIPT_NAMES.filter((n) => n !== "add-provider.sh") }),
        expect.any(String),
      );
    } finally {
      rmSync(rootOverride, { recursive: true, force: true });
    }
  });

  it("neither route is ever prerendered: a build-time answer would describe the build machine", () => {
    expect(folderDynamic).toBe("force-dynamic");
    expect(scriptDynamic).toBe("force-dynamic");
  });
});

describe("packaging", () => {
  it("the npm package, which the desktop runtime bundle is installed from, ships the scripts folder", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("lib/**/*");
    expect(pkg.files.filter((pattern) => /^!(?:\*\*\/)?lib\b|\.(?:sh|ps1)\b/.test(pattern))).toEqual([]);
  });
});
