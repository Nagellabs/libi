// A user who installs Kokoro (121 MB), Whisper (up to 1.5 GB) or the
// tracking engine (~2 GB) had no in-app way to get that disk back: there was no
// Remove, Delete or Uninstall control anywhere libi listed its extensions —
// removing one of the user's OWN providers is a command they submit on the
// Agents page, and has nothing to do with libi's extensions.
//
// The risk this file pins is the opposite one — a Remove that takes a shared
// dependency with it and breaks a neighbouring extension the user did not
// touch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  REMOVABLE_EXTENSION_IDS,
  isRemovableExtension,
  removeExtensionFiles,
} from "@/mcp/registry/extension-uninstall";
import { EXTENSION_MCP_SERVERS } from "@/mcp/registry/bundled";
import { ttsModelsDir } from "@/lib/tts/voices";
import { whisperModelsDir } from "@/lib/whisper/models";
import { trackingModelsDir } from "@/lib/tracking/engine-deps";
import { trackingVenvDir } from "@/lib/uv-env/spawn-env";
import { getLibiBinDir, getLibiHome, getLibiModelsDir } from "@/lib/libi-home";

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ext-remove-"));
  prevHome = process.env.LIBI_HOME;
  process.env.LIBI_HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedFile(file: string, bytes = 1024): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
}

describe("which extensions are removable", () => {
  it("names only real extension ids", () => {
    const known = new Set(EXTENSION_MCP_SERVERS.map((d) => d.id));
    for (const id of REMOVABLE_EXTENSION_IDS) expect(known.has(id)).toBe(true);
  });

  it("refuses the extensions whose deps are SHARED", () => {
    // `libi-export` owns chromium, which the tracking engine also launches;
    // `youtube-download` owns `uv` and a uv-installed yt-dlp, shared with three
    // other extensions. Removing either would break a neighbour.
    expect(isRemovableExtension("libi-export")).toBe(false);
    expect(isRemovableExtension("youtube-download")).toBe(false);
    expect(isRemovableExtension("libi")).toBe(false);
  });

  it("throws rather than guessing for an id it does not own", () => {
    expect(() => removeExtensionFiles("libi-export")).toThrow(/no files of its own/i);
  });
});

describe("removeExtensionFiles", () => {
  it("deletes Kokoro's model directory and its env token, and reports the bytes", () => {
    seedFile(path.join(ttsModelsDir(), "kokoro.onnx"), 92_000);
    seedFile(path.join(ttsModelsDir(), ".install-token"), 40);
    seedFile(path.join(getLibiHome(), ".libi-tts-env.install-token"), 40);

    const result = removeExtensionFiles("local-tts");

    expect(fs.existsSync(ttsModelsDir())).toBe(false);
    expect(fs.existsSync(path.join(getLibiHome(), ".libi-tts-env.install-token"))).toBe(false);
    expect(result.freedBytes).toBe(92_040);
  });

  it("takes the tracking engine's models, its venv and the mediapipe assets", () => {
    seedFile(path.join(trackingModelsDir(), "yoloe.onnx"));
    seedFile(path.join(trackingVenvDir(), "bin", "python"));
    seedFile(path.join(getLibiModelsDir(), "mediapipe-vision", "vision.wasm"));

    removeExtensionFiles("libi-tracking");

    expect(fs.existsSync(trackingModelsDir())).toBe(false);
    expect(fs.existsSync(trackingVenvDir())).toBe(false);
    expect(fs.existsSync(path.join(getLibiModelsDir(), "mediapipe-vision"))).toBe(false);
  });

  it("NEVER touches shared state — uv, its cache, or another extension's models", () => {
    const uvBinary = path.join(getLibiBinDir(), "uv");
    const uvCache = path.join(getLibiHome(), "uv", "cache", "wheel");
    seedFile(uvBinary);
    seedFile(uvCache);
    seedFile(path.join(ttsModelsDir(), "kokoro.onnx"));
    seedFile(path.join(whisperModelsDir(), "tiny", "model.bin"));

    removeExtensionFiles("local-tts");

    expect(fs.existsSync(uvBinary)).toBe(true);
    expect(fs.existsSync(uvCache)).toBe(true);
    // Whisper's own download survives its neighbour's removal.
    expect(fs.existsSync(path.join(whisperModelsDir(), "tiny", "model.bin"))).toBe(true);
  });

  it("is a no-op on an extension that was never installed", () => {
    const result = removeExtensionFiles("whisper");
    expect(result.removed).toEqual([]);
    expect(result.freedBytes).toBe(0);
  });
});
