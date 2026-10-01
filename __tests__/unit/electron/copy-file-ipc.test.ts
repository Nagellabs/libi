import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * "Copy" on an export puts the FILE on the OS clipboard (spec 2026-09-29 §A6).
 * Main copies only a regular file directly inside `<storage>/<pieceId>/exports/`
 * — never an arbitrary path the renderer names — and answers false where the
 * platform can't (the renderer then copies the path). `electron` is mocked.
 */
const h = vi.hoisted(() => ({
  handle: vi.fn(),
  writeBuffer: vi.fn(),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  log: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: h.handle },
  clipboard: { writeBuffer: h.writeBuffer },
  contextBridge: { exposeInMainWorld: h.exposeInMainWorld },
  ipcRenderer: { invoke: h.invoke },
}));
vi.mock("../../../electron/sync-log", () => ({ mainSyncLog: h.log }));

import { COPY_FILE_CHANNEL, copyableExportPath, libiStorageRoots, registerCopyFileIpc } from "../../../electron/copy-file";
import { MAC_FILE_CLIPBOARD_FORMAT } from "../../../electron/clipboard-formats";

let home: string;
let storage: string;
let exportFile: string;

function handler(platform: NodeJS.Platform): (e: unknown, p: unknown) => boolean {
  h.handle.mockClear();
  registerCopyFileIpc({ roots: () => [storage], platform });
  const call = h.handle.mock.calls.find(([channel]) => channel === COPY_FILE_CHANNEL);
  expect(call, "the channel is registered with ipcMain.handle").toBeTruthy();
  return call![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-copy-file-")));
  storage = path.join(home, "storage");
  fs.mkdirSync(path.join(storage, "p1", "exports"), { recursive: true });
  exportFile = path.join(storage, "p1", "exports", "A & B.mp4");
  fs.writeFileSync(exportFile, "bytes");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("copyableExportPath", () => {
  it("accepts a file directly in a piece's exports folder", () => {
    expect(copyableExportPath(exportFile, [storage])).toBe(exportFile);
  });

  it("refuses anything else: outside storage, an asset, a folder, a relative path, a non-string, a symlink out", () => {
    const outside = path.join(home, "secret.txt");
    fs.writeFileSync(outside, "x");
    const asset = path.join(storage, "p1", "clip.mp4");
    fs.writeFileSync(asset, "x");
    const link = path.join(storage, "p1", "exports", "link.mp4");
    fs.symlinkSync(outside, link);
    expect(copyableExportPath(outside, [storage])).toBeNull();
    expect(copyableExportPath(asset, [storage])).toBeNull();
    expect(copyableExportPath(path.join(storage, "p1", "exports"), [storage])).toBeNull();
    expect(copyableExportPath("p1/exports/A & B.mp4", [storage])).toBeNull();
    expect(copyableExportPath(42, [storage])).toBeNull();
    expect(copyableExportPath(link, [storage])).toBeNull();
  });
});

describe("libi:copy-file", () => {
  it("macOS: writes the file reference (the format A0 decided) and answers true", () => {
    expect(handler("darwin")({}, exportFile)).toBe(true);
    expect(h.writeBuffer).toHaveBeenCalledTimes(1);
    const [format, buf] = h.writeBuffer.mock.calls[0] as [string, Buffer];
    expect(format).toBe(MAC_FILE_CLIPBOARD_FORMAT);
    if (format === "NSFilenamesPboardType") {
      expect(buf.toString("utf8")).toContain(`<string>${exportFile.replace("&", "&amp;")}</string>`);
    } else {
      expect(buf.toString("utf8")).toMatch(/^file:\/\//);
    }
  });

  it("refuses a path outside the exports folders: answers false and writes nothing", () => {
    expect(handler("darwin")({}, path.join(home, "nope.mp4"))).toBe(false);
    expect(h.writeBuffer).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/refused/));
  });

  it("Linux (and Windows until a file-drop write is verified) answers false so the renderer copies the path", () => {
    expect(handler("linux")({}, exportFile)).toBe(false);
    expect(h.writeBuffer).not.toHaveBeenCalled();
  });
});

describe("libiStorageRoots — mirrors lib/libi-home.ts", () => {
  const OLD = process.env.LIBI_HOME;
  afterEach(() => {
    if (OLD === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = OLD;
  });

  it("LIBI_HOME/storage, plus STORAGE_DIR when set — the same dir the server serves from", async () => {
    process.env.LIBI_HOME = home;
    const { getLibiStorageDir } = await import("@/lib/libi-home");
    expect(libiStorageRoots({ LIBI_HOME: home })).toEqual([getLibiStorageDir()]);
    expect(libiStorageRoots({ LIBI_HOME: home, STORAGE_DIR: "/data/s" })).toEqual(["/data/s", path.join(home, "storage")]);
  });

  it("no LIBI_HOME: ~/.libi/config.json's libiHome, else ~/.libi", () => {
    const fakeHome = path.join(home, "user");
    fs.mkdirSync(path.join(fakeHome, ".libi"), { recursive: true });
    expect(libiStorageRoots({}, fakeHome)).toEqual([path.join(fakeHome, ".libi", "storage")]);
    fs.writeFileSync(path.join(fakeHome, ".libi", "config.json"), JSON.stringify({ libiHome: "/Volumes/Media/libi" }));
    expect(libiStorageRoots({}, fakeHome)).toEqual([path.join("/Volumes/Media/libi", "storage")]);
  });
});

describe("the preload bridge and main", () => {
  it("preload exposes copyFileToClipboard over libi:copy-file", async () => {
    await import("../../../electron/preload");
    const api = h.exposeInMainWorld.mock.calls.find(([key]) => key === "electronAPI")?.[1] as { copyFileToClipboard: (p: string) => unknown };
    await api.copyFileToClipboard("/x/y.mp4");
    expect(h.invoke).toHaveBeenCalledWith("libi:copy-file", "/x/y.mp4");
  });

  it("main registers the handler", () => {
    expect(fs.readFileSync("electron/main.ts", "utf8")).toMatch(/registerCopyFileIpc\(\)/);
  });
});
