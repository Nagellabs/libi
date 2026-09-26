/**
 * Which preview-source load failures are PERMANENT (stop, fall back once, then
 * show the "can't be played" placeholder) and which are TRANSIENT (bounded
 * backoff). docs-local/qa/2026-09-25-video-download-and-playback-plan.md T3: a
 * 400 from the proxy route used to be re-requested on every pump restart and
 * the player sat on "Buffering…" forever.
 */
import { describe, it, expect } from "vitest";
import {
  classifyMediaLoadError,
  httpStatusOf,
  UnplayableMediaError,
  TRANSIENT_RETRY_DELAYS_SEC,
} from "@/lib/engine/media-load-failure";

/** The exact shape mediabunny's UrlSource throws for a non-ok response. */
const httpError = (status: number, text: string) =>
  new Error(`Error fetching /api/files/by-id/f1/proxy: ${status} ${text}`);

function domError(name: string): Error {
  const e = new Error(`${name} happened`);
  e.name = name;
  return e;
}

describe("classifyMediaLoadError", () => {
  it.each([
    [400, "Bad Request"],
    [403, "Forbidden"],
    [404, "Not Found"],
    [410, "Gone"],
    [416, "Range Not Satisfiable"],
  ])("HTTP %i is permanent", (status, text) => {
    expect(classifyMediaLoadError(httpError(status, text))).toBe("permanent");
  });

  it.each([
    [408, "Request Timeout"],
    [429, "Too Many Requests"],
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
    [503, "Service Unavailable"],
  ])("HTTP %i is transient", (status, text) => {
    expect(classifyMediaLoadError(httpError(status, text))).toBe("transient");
  });

  it("a network failure is transient", () => {
    expect(classifyMediaLoadError(new TypeError("Failed to fetch"))).toBe("transient");
    expect(classifyMediaLoadError(new TypeError("fetch failed"))).toBe("transient");
  });

  it("a demux / unsupported-format error is permanent", () => {
    expect(
      classifyMediaLoadError(new Error("Input has an unsupported or unrecognizable format.")),
    ).toBe("permanent");
  });

  it("an HEVC stream mediabunny can't build a decoder config for (MPEG-TS, unparsable SPS) is permanent: play the proxy", () => {
    expect(
      classifyMediaLoadError(new Error("Invalid HEVC video stream; could not extract HVCDecoderConfigurationRecord from first packet.")),
    ).toBe("permanent");
  });

  it("libi's own unplayable verdict (no video track, codec can't decode) is permanent", () => {
    expect(classifyMediaLoadError(new UnplayableMediaError("codec hevc can't be decoded"))).toBe(
      "permanent",
    );
  });

  it("a WebCodecs decoder rejection is permanent", () => {
    expect(classifyMediaLoadError(domError("EncodingError"))).toBe("permanent");
    expect(classifyMediaLoadError(domError("NotSupportedError"))).toBe("permanent");
    expect(classifyMediaLoadError(domError("DataError"))).toBe("permanent");
  });

  it("anything unrecognised is transient (bounded retries, then it still gives up)", () => {
    expect(classifyMediaLoadError(new Error("something odd"))).toBe("transient");
    expect(classifyMediaLoadError("weird")).toBe("transient");
  });

  it("the transient backoff is bounded", () => {
    expect(TRANSIENT_RETRY_DELAYS_SEC.length).toBeGreaterThan(0);
    expect(TRANSIENT_RETRY_DELAYS_SEC.length).toBeLessThanOrEqual(5);
    expect(TRANSIENT_RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15);
  });
});

describe("httpStatusOf", () => {
  it("reads the status out of mediabunny's fetch error, and null for anything else", () => {
    expect(httpStatusOf(httpError(404, "Not Found"))).toBe(404);
    expect(httpStatusOf(httpError(503, "Service Unavailable"))).toBe(503);
    expect(httpStatusOf(new DOMException("Unsupported configuration.", "OperationError"))).toBeNull();
    expect(httpStatusOf(new Error("Failed to fetch"))).toBeNull();
  });
});
