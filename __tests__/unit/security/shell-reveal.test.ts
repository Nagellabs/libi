import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Prevent the route from actually shelling out to `open`/`explorer`/`xdg-open`.
const spawnMock = vi.fn(() => ({ unref: () => {} }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function post(body: unknown): Request {
  return new Request("http://127.0.0.1:3456/api/shell/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/shell/reveal — non-oracle response (RC-A)", () => {
  let tmpDir: string;
  let existingFile: string;
  let missingPath: string;

  beforeEach(() => {
    spawnMock.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-reveal-test-"));
    existingFile = path.join(tmpDir, "real-file.txt");
    fs.writeFileSync(existingFile, "hi");
    missingPath = path.join(tmpDir, "does-not-exist-xyz.txt");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an identical response shape/status for existing and missing paths", async () => {
    const { POST } = await import("@/app/api/shell/reveal/route");

    const existingRes = await POST(post({ path: existingFile }));
    const missingRes = await POST(post({ path: missingPath }));

    expect(existingRes.status).toBe(200);
    expect(missingRes.status).toBe(existingRes.status);

    const existingBody = await existingRes.json();
    const missingBody = await missingRes.json();
    expect(existingBody).toEqual({ ok: true });
    expect(missingBody).toEqual(existingBody);
  });

  it("does not leak existence for an out-of-bounds path either", async () => {
    const { POST } = await import("@/app/api/shell/reveal/route");

    // A path outside $HOME and the temp dir — previously a 400, now generic.
    const outOfBounds = "/etc/shadow";
    const res = await POST(post({ path: outOfBounds }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // And it must not have attempted to reveal it.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still performs a real reveal for a legitimate existing path", async () => {
    const { POST } = await import("@/app/api/shell/reveal/route");

    spawnMock.mockClear();
    await POST(post({ path: existingFile }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("still rejects a malformed body with 400 (request-shape error, not filesystem)", async () => {
    const { POST } = await import("@/app/api/shell/reveal/route");

    const res = await POST(post({}));
    expect(res.status).toBe(400);
  });
});

describe("/api/shell/reveal — allowlist covers libi's own configurable roots", () => {
  let externalRoot: string;
  let fileUnderLibiHome: string;
  const OLD_LIBI_HOME = process.env.LIBI_HOME;

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockClear();
    // MUST be outside BOTH $HOME and os.tmpdir(). An earlier version of this
    // fixture used os.tmpdir(), which revealRoots() allowlists
    // unconditionally — so the test passed with getLibiHome() deleted from
    // the root list entirely, proving nothing about LIBI_HOME. /var/tmp is a
    // distinct directory from os.tmpdir() on both macOS (/var/folders/...)
    // and ubuntu CI (/tmp), and is writable on both.
    externalRoot = fs.mkdtempSync(path.join("/var/tmp", "libi-external-root-"));
    const storage = path.join(externalRoot, "storage", "p1");
    fs.mkdirSync(storage, { recursive: true });
    fileUnderLibiHome = path.join(storage, "clip.mp4");
    fs.writeFileSync(fileUnderLibiHome, "x");
    process.env.LIBI_HOME = externalRoot;
  });

  afterEach(() => {
    if (OLD_LIBI_HOME === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = OLD_LIBI_HOME;
    fs.rmSync(externalRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("reveals a file under a relocated LIBI_HOME", async () => {
    const { POST } = await import("@/app/api/shell/reveal/route");

    const res = await POST(post({ path: fileUnderLibiHome }));
    expect(res.status).toBe(200);
    // The point of the change: before LIBI_HOME joined the allowlist this
    // spawned nothing and the user got a button that did nothing at all.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Assert on the CONTAINING DIRECTORY, which every platform's argument
    // references, rather than on the file path, which only macOS and Windows
    // pass. Linux has no native "reveal", so the route opens the parent
    // (`xdg-open <dirname>`) — asserting the file path here passed on a Mac
    // and failed on ubuntu CI, which is the whole point of this repo's
    // "a green suite on your Mac is not a green CI" rule.
    const args = (spawnMock.mock.calls[0]?.[1] ?? []).join(" ");
    expect(args).toContain(path.dirname(fileUnderLibiHome));
  });

  it("still refuses a path outside every allowed root", async () => {
    const { POST } = await import("@/app/api/shell/reveal/route");

    const res = await POST(post({ path: "/etc/shadow" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
