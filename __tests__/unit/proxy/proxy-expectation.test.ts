/**
 * proxyExpectation: whether a file has, will have, or can never have a proxy.
 * The preview's audio engine reads it to decide when to ask for the proxy
 * stand-in (Re-review R4): never for a file that can't have one, and only once
 * it is ready for a file whose proxy job hasn't finished.
 */
import { describe, it, expect } from "vitest";
import { proxyExpectation, proxyStatusForFile } from "@/lib/proxy/expectation";

type Row = Parameters<typeof proxyExpectation>[0];
const video = (o: Record<string, unknown> = {}): Row =>
  ({ type: "video", hasAlpha: false, proxyStatus: "idle", proxyFilename: null, filename: "a.mp4", contentType: "video/mp4", ...o }) as Row;

describe("proxyExpectation", () => {
  it("is none for a file that can never have a proxy", () => {
    expect(proxyExpectation(undefined)).toBe("none");
    expect(proxyExpectation(video({ type: "audio", filename: "a.m4a" }))).toBe("none");
    expect(proxyExpectation(video({ type: "image" }))).toBe("none");
    // VPx alpha: proxy_gen refuses it (an H.264 proxy would restore the background).
    expect(proxyExpectation(video({ hasAlpha: true, filename: "cut.webm", contentType: "video/webm" }))).toBe("none");
  });
  it("an audio file: a proxy only once its job runs (made only when the preview can't play it: review round 4)", () => {
    const audio = (o: Record<string, unknown> = {}) => video({ type: "audio", filename: "radio.ogg", contentType: "audio/ogg", ...o });
    expect(proxyExpectation(audio({ proxyStatus: "idle" }))).toBe("none");
    expect(proxyExpectation(audio({ proxyStatus: "generating" }))).toBe("pending");
    expect(proxyExpectation(audio({ proxyStatus: "ready", proxyFilename: "radio-proxy.m4a" }))).toBe("ready");
    expect(proxyExpectation(audio({ proxyStatus: "failed" }))).toBe("none");
  });
  it("is none when the proxy job failed", () => {
    expect(proxyExpectation(video({ proxyStatus: "failed" }))).toBe("none");
  });
  it("is pending while the proxy is idle or generating", () => {
    expect(proxyExpectation(video({ proxyStatus: "idle" }))).toBe("pending");
    expect(proxyExpectation(video({ proxyStatus: "generating" }))).toBe("pending");
    // Non-VPx alpha (ProRes 4444) DOES get an opaque proxy.
    expect(proxyExpectation(video({ hasAlpha: true, filename: "a.mov", contentType: "video/quicktime" }))).toBe("pending");
  });
  it("is ready once the proxy exists", () => {
    expect(proxyExpectation(video({ proxyStatus: "ready", proxyFilename: "a-proxy.mp4" }))).toBe("ready");
    expect(proxyExpectation(video({ proxyStatus: "ready", proxyFilename: null }))).toBe("pending");
  });
});

describe("proxyStatusForFile (final review F1, F2)", () => {
  const ready = (id: string, at: string) => ({ ...(video({ proxyStatus: "ready", proxyFilename: "p.mp4" }) as object), id, proxyGeneratedAt: at });
  it("looks the file up in the piece's files, then the global library, and carries the proxy's revision", () => {
    const piece = [ready("f-piece", "2026-09-25T10:00:00.000Z")];
    const global = [ready("f-global", "2026-09-25T11:00:00.000Z")];
    expect(proxyStatusForFile("f-piece", piece as never, global as never)).toEqual({ state: "ready", revision: "2026-09-25T10:00:00.000Z" });
    expect(proxyStatusForFile("f-global", piece as never, global as never)).toEqual({ state: "ready", revision: "2026-09-25T11:00:00.000Z" });
  });
  it("is 'unknown' for a file in neither list", () => {
    expect(proxyStatusForFile("f-x", [], [])).toEqual({ state: "unknown", revision: null });
    expect(proxyStatusForFile("f-x", [], undefined)).toEqual({ state: "unknown", revision: null });
  });
  it("a Date revision (a row from the server process) reads the same as its JSON string", () => {
    const row = { ...(video({ proxyStatus: "ready", proxyFilename: "p.mp4" }) as object), id: "f", proxyGeneratedAt: new Date("2026-09-25T10:00:00.000Z") };
    expect(proxyStatusForFile("f", [row] as never, [])).toEqual({ state: "ready", revision: "2026-09-25T10:00:00.000Z" });
  });
});
