// The studio's stand-in for ElevenLabs' media hosting in test mode (app/api/test-mode/elevenlabs). Outside test
// mode it must not exist, to any method; inside, it serves only the fake's own placeholders and uploads.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as route from "@/app/api/test-mode/elevenlabs/[...path]/route";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const ASSET = "asset_fake_0123456789abcdef";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "libi-el-route-"));
  process.env.LIBI_HOME = home;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  delete process.env.LIBI_TEST_MODE;
  rmSync(home, { recursive: true, force: true });
});

const call = (method: (typeof METHODS)[number], path: string[], init: RequestInit = {}) =>
  route[method](new Request(`http://127.0.0.1:3999/api/test-mode/elevenlabs/${path.join("/")}`, { method, ...init }), {
    params: Promise.resolve({ path }),
  });

describe("/api/test-mode/elevenlabs", () => {
  it("answers a bare 404 to every method outside test mode", async () => {
    mkdirSync(join(home, "test-mode", "elevenlabs-out"), { recursive: true });
    writeFileSync(join(home, "test-mode", "elevenlabs-out", "el_tts_a.wav"), "RIFF");
    for (const method of METHODS) {
      const res = await call(method, ["out", "el_tts_a.wav"]);
      expect(res.status, method).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("in test mode serves a placeholder by name, and nothing outside its folder", async () => {
    process.env.LIBI_TEST_MODE = "1";
    mkdirSync(join(home, "test-mode", "elevenlabs-out"), { recursive: true });
    writeFileSync(join(home, "test-mode", "elevenlabs-out", "el_tts_a.wav"), "RIFF-bytes");
    writeFileSync(join(home, "secret.txt"), "no");
    const ok = await call("GET", ["out", "el_tts_a.wav"]);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/wav");
    expect(await ok.text()).toBe("RIFF-bytes");
    for (const path of [["out", "..", "secret.txt"], ["out", "..%2Fsecret.txt"], ["out", "missing.wav"], ["elsewhere", "x.wav"]]) {
      expect((await call("GET", path)).status, path.join("/")).toBe(404);
    }
    expect((await call("POST", ["out", "el_tts_a.wav"])).status).toBe(405);
  });

  it("in test mode takes an upload's bytes only with the Content-Type it was started with", async () => {
    process.env.LIBI_TEST_MODE = "1";
    const dir = join(home, "test-mode", "elevenlabs-uploads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ASSET}.json`), JSON.stringify({ mime_type: "audio/wav", file_size: 4, name: "a.wav" }));
    const wrong = await call("PUT", ["upload", ASSET], { body: "RIFF", headers: { "content-type": "audio/mpeg" } });
    expect(wrong.status).toBe(403);
    const right = await call("PUT", ["upload", ASSET], { body: "RIFF", headers: { "content-type": "audio/wav" } });
    expect(right.status).toBe(200);
    // Like the live GCS upload session: 200 with the stored object's JSON.
    expect(await right.json()).toMatchObject({ kind: "storage#object", contentType: "audio/wav", size: "4" });
    expect(readFileSync(join(dir, `${ASSET}.bin`), "utf8")).toBe("RIFF");
    // An asset no upload was started for, or a name that is not an asset id.
    expect((await call("PUT", ["upload", "asset_fake_ffffffffffffffff"], { body: "x", headers: { "content-type": "audio/wav" } })).status).toBe(404);
    expect((await call("PUT", ["upload", "../x"], { body: "x", headers: { "content-type": "audio/wav" } })).status).toBe(404);
  });
});
