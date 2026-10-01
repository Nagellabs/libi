/**
 * `libi.social_music_search` — the agent's read of a piece's music plan on one
 * platform, plus the platform catalog's candidates where there is one. It runs
 * in the MCP child, so everything goes over the studio's HTTP routes (mocked
 * here as a route table, like social-tools.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { socialMusicSearch } from "@/mcp/tools/social-music-tools";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
let routes: Array<[RegExp, () => { status?: number; body: unknown }]> = [];

const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
  const route = routes.find(([re]) => re.test(u));
  const answer = route ? route[1]() : { status: 404, body: { error: "no route in test" } };
  const status = answer.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => answer.body } as unknown as Response;
});

function planRoute(plan: Record<string, unknown>, platform = "instagram") {
  return [/\/api\/social\/music\/plan$/, () => ({ body: { copyrighted: true, hasMusic: true, variants: {}, targets: [{ platform, plan, music: { mode: plan.mode } }] } })] as [
    RegExp,
    () => { body: unknown },
  ];
}

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("libi.social_music_search", () => {
  it("answers the plan and the candidates, and which one it auto-selected", async () => {
    routes = [
      planRoute({ mode: "attach", track: { id: "ig-1", title: "Espresso" }, sentence: "S", warnings: [], exportVariant: "without-song", allowedModes: ["attach", "include", "strip"] }),
      [
        /\/api\/social\/music\/catalog\?/,
        () => ({ body: { tracks: [{ id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter", kind: "search" }, { id: "ig-2", title: "Espresso (Live)", kind: "search" }] } }),
      ],
    ];
    const r = await socialMusicSearch({ pieceId: "p1", platform: "instagram", accountId: "ig", query: "espresso" });
    expect(r).toEqual({
      success: true,
      data: {
        plan: { mode: "attach", sentence: "S", warnings: [], exportVariant: "without-song", allowedModes: ["attach", "include", "strip"] },
        candidates: [{ id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" }, { id: "ig-2", title: "Espresso (Live)" }],
        autoSelected: "ig-1",
        exportVideoArgs: { pieceId: "p1", purpose: "social", copyrightedAudio: "exclude" },
        exportNote: expect.stringContaining("libi.post_piece"),
      },
    });
    expect(calls.find((c) => c.url.includes("/plan"))!.body).toEqual({ pieceId: "p1", targets: [{ platform: "instagram", accountId: "ig" }] });
    expect(calls.find((c) => c.url.includes("/catalog?"))!.url).toContain("q=espresso");
  });

  it("needs an account for Instagram and TikTok", async () => {
    expect(await socialMusicSearch({ pieceId: "p1", platform: "tiktok" })).toMatchObject({ success: false, error: "account_required" });
    expect(await socialMusicSearch({ pieceId: "p1", platform: "instagram" })).toMatchObject({ success: false, error: "account_required" });
    expect(calls).toEqual([]);
  });

  it("YouTube: the plan only, no catalog call, and a with-song social export", async () => {
    const sentence = "Keeps the song in the video. YouTube will likely claim it: the owner may run ads on it or block it in some countries. It is not a strike.";
    routes = [planRoute({ mode: "include", sentence, warnings: [], exportVariant: "with-song", allowedModes: ["include", "strip"] }, "youtube")];
    const r = await socialMusicSearch({ pieceId: "p1", platform: "youtube" });
    expect(r).toMatchObject({
      success: true,
      data: { plan: { mode: "include", sentence, exportVariant: "with-song" }, candidates: [], autoSelected: null, exportVideoArgs: { pieceId: "p1", purpose: "social", copyrightedAudio: "include" } },
    });
    expect((r.data as { exportNote: string }).exportNote).toMatch(/libi\.export_video/);
    expect(calls.some((c) => c.url.includes("/catalog"))).toBe(false);
  });

  it("Facebook and X: strip means a social export without the song", async () => {
    for (const platform of ["facebook", "twitter"] as const) {
      routes = [planRoute({ mode: "strip", sentence: "Posts without *Espresso — Sabrina Carpenter*; the video keeps its other sound.", warnings: [], exportVariant: "without-song", allowedModes: ["include", "strip"] }, platform)];
      const r = await socialMusicSearch({ pieceId: "p1", platform });
      expect(r).toMatchObject({ success: true, data: { plan: { mode: "strip" }, exportVideoArgs: { purpose: "social", copyrightedAudio: "exclude" } } });
    }
    expect(calls.some((c) => c.url.includes("/catalog"))).toBe(false);
  });

  it("an unavailable catalog is reported alongside the plan", async () => {
    routes = [
      planRoute({ mode: "strip", sentence: "S", warnings: [], needs: "Reconnect Instagram with Facebook Login to attach licensed music.", exportVariant: "without-song", allowedModes: ["include", "strip"] }),
      [/\/api\/social\/music\/catalog\?/, () => ({ body: { unavailable: { reason: "needs_facebook_login" } } })],
    ];
    const r = await socialMusicSearch({ pieceId: "p1", platform: "instagram", accountId: "ig" });
    expect(r).toMatchObject({ success: true, data: { plan: { needs: expect.stringMatching(/Facebook Login/) }, candidates: [], autoSelected: null, unavailable: "needs_facebook_login" } });
  });

  it("the plan route failing is an error the agent can act on", async () => {
    routes = [[/\/api\/social\/music\/plan$/, () => ({ status: 401, body: { error: "needs_reconnect" } })]];
    expect(await socialMusicSearch({ pieceId: "p1", platform: "tiktok", accountId: "tt" })).toMatchObject({ success: false, error: "music_plan_unavailable", data: { status: 401 } });
  });
});
