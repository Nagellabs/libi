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
