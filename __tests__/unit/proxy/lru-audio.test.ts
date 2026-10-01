/**
 * Audio proxies share the proxy disk budget (review round 5, M4). They used to
 * be exempt, so an ALAC library kept ~580 MB per 100 songs for good. Now they
 * count, and are evicted only after every video proxy not in use: an evicted
 * one is re-made on the piece's next open (lib/proxy/ensure.ts). In-use
 * protection is unchanged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { DEFAULT_PROXY_BYTE_BUDGET, proxyByteBudget, selectProxiesToEvict, type ProxyEntry } from "@/lib/proxy/lru";

const e = (fileId: string, bytes: number, generatedAt: number, over: Partial<ProxyEntry> = {}): ProxyEntry => ({
  fileId, bytes, generatedAt, inUse: false, audio: false, ...over,
});

describe("selectProxiesToEvict with audio proxies", () => {
  it("over budget with only audio proxies not in use: the oldest audio proxy goes", () => {
    expect(selectProxiesToEvict([e("a-new", 50, 30, { audio: true }), e("a-old", 50, 10, { audio: true })], 60)).toEqual(["a-old"]);
  });

  it("every video proxy not in use goes before any audio proxy, however old", () => {
    const entries = [
      e("audio-oldest", 50, 1, { audio: true }),
      e("video-1", 50, 20),
      e("video-2", 50, 30),
    ];
    expect(selectProxiesToEvict(entries, 60)).toEqual(["video-1", "video-2"]);
    expect(selectProxiesToEvict(entries, 10)).toEqual(["video-1", "video-2", "audio-oldest"]);
  });

  it("in-use video proxies are still evicted last; an in-use AUDIO proxy never is (review m5)", () => {
    const entries = [
      e("audio-in-use", 50, 1, { audio: true, inUse: true }),
      e("audio", 50, 40, { audio: true }),
      e("video-in-use", 50, 2, { inUse: true }),
      e("video", 50, 50),
    ];
    expect(selectProxiesToEvict(entries, 100)).toEqual(["video", "audio"]);
    expect(selectProxiesToEvict(entries, 0)).toEqual(["video", "audio", "video-in-use"]);
  });
});

describe("LIBI_PROXY_BYTE_BUDGET (review m8)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is honoured in a dev or test build", () => {
    vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", "1234");
    vi.stubEnv("NODE_ENV", "development");
    expect(proxyByteBudget()).toBe(1234);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(proxyByteBudget()).toBe(1234);
  });

  it("is ignored by a production server (packaged, npx)", () => {
    vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", "1234");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(proxyByteBudget()).toBe(DEFAULT_PROXY_BYTE_BUDGET);
  });

  it("anything but a positive whole number is the default", () => {
    for (const v of ["0", "-5", "1.5", "abc"]) {
      vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", v);
      expect(proxyByteBudget()).toBe(DEFAULT_PROXY_BYTE_BUDGET);
    }
  });
});
