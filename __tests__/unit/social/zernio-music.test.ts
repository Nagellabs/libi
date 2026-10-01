import { describe, it, expect, vi, afterEach } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { fakeZernioMcp } from "@/__tests__/helpers/zernio-fake";
import { ZernioAdapter, musicUnavailableReason } from "@/lib/social/providers/zernio/adapter";
import { toSocialError } from "@/lib/social/mcp-client";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SocialError } from "@/lib/social/errors";
import cml from "@/lib/social/providers/zernio/fixtures/tiktok-commercial-music.json";
import igAudio from "@/lib/social/providers/zernio/fixtures/instagram-audio.json";

const TT = "6aae6ba98d284ffb211ae03a";
const IG = "6aae6b468d284ffb211ade1e";
/** Verified live 2026-09-27 on the owner's Instagram-Login account. */
const IG_FB_LOGIN = 'Error: [400] The Instagram audio catalog requires an account connected via Facebook Login. Reconnect this account choosing the "Facebook" connection method, then retry. (field: accountId; code: instagram_audio_requires_facebook_login)';
const adapterFor = (answers: Record<string, unknown>) => {
  const { mcp, calls } = fakeZernioMcp(answers);
  return { adapter: new ZernioAdapter(mcp, { aiLabelDefault: true }), calls };
};
afterEach(() => vi.clearAllMocks());

describe("Zernio music catalog", () => {
  it("TikTok: the live track shape, ids from tracks[].id (never commercialMusicId), via call_tool", async () => {
    const { adapter, calls } = adapterFor({ accounts_list_tik_tok_commercial_music: cml });
    const r = await adapter.musicCatalog(TT, { platform: "tiktok", countryCode: "TH" });
    expect(r).toEqual({
      tracks: [
        { id: "7521888697513396241", title: "Self Aware", artist: "Mark Allan Wolfe", durationSec: 227, previewUrl: cml.tracks[0].previewUrl, artworkUrl: cml.tracks[0].thumbnailUrl, kind: "trending", rank: 1 },
        expect.objectContaining({ id: "7584037896080902145", title: "Sunset in Girona", rank: 2 }),
      ],
    });
    expect(calls[0]).toEqual({ name: "accounts_list_tik_tok_commercial_music", args: { account_id: TT, country_code: "TH" }, via: "call_tool" });
  });

  it("Instagram: search with q, trending without; artist falls back to the uploader for an original sound", async () => {
    const { adapter, calls } = adapterFor({ instagram_search_instagram_audio: igAudio });
    const r = await adapter.musicCatalog(IG, { platform: "instagram", query: "summer" });
    expect(r).toEqual({
      tracks: [
        { id: "482851939985510", title: "Summer Nights", artist: "The Example Band", durationSec: 182, previewUrl: igAudio.audio[0].downloadUrl, kind: "search" },
        { id: "990000000000001", title: "my original", artist: "someone", durationSec: 15, kind: "search" },
      ],
    });
    expect(calls[0].args).toEqual({ account_id: IG, audio_type: "music", q: "summer" });
    await adapter.musicCatalog(IG, { platform: "instagram" });
    expect(calls[1].args).toEqual({ account_id: IG, audio_type: "music" });
  });

  it("Instagram-Login account → needs_facebook_login (the live 400)", async () => {
    const { adapter } = adapterFor({ instagram_search_instagram_audio: () => { throw toSocialError(new Error(IG_FB_LOGIN)); } });
    expect(await adapter.musicCatalog(IG, { platform: "instagram" })).toEqual({ unavailable: { reason: "needs_facebook_login", detail: IG_FB_LOGIN } });
  });

  it("TikTok not on the Business lane (any 4xx) → not_business; 5xx → error; unauthorized rethrows", () => {
    expect(musicUnavailableReason("tiktok", toSocialError(new Error("Error: [403] nope (code: whatever)")))).toBe("not_business");
    expect(musicUnavailableReason("tiktok", toSocialError(new Error("Error: [400] nope")))).toBe("not_business");
    expect(musicUnavailableReason("tiktok", toSocialError(new Error("Error: [502] upstream")))).toBe("error");
    expect(musicUnavailableReason("tiktok", toSocialError(new Error("Error: [429] slow down")))).toBe("error");
    expect(() => musicUnavailableReason("tiktok", new SocialError("unauthorized", "gone", { status: 401 }))).toThrow(SocialError);
  });

  /** Review finding: a TRANSPORT-level 4xx (the SDK's "No valid session ID"
   *  400) is not Zernio answering the tool — reading it as not_business stored
   *  the account's TikTok kind as personal, "detected". Only a status the
   *  tool's own answer text carries says anything about the connection. */
  it("a transport-level 4xx is an error, never not_business; only a text-borne 4xx is", () => {
    const transport400 = toSocialError(new StreamableHTTPError(400, "Error POSTing to endpoint: No valid session ID provided"));
    expect(transport400.status).toBe(400);
    expect(musicUnavailableReason("tiktok", transport400)).toBe("error");
    expect(musicUnavailableReason("tiktok", toSocialError(new StreamableHTTPError(403, "Error POSTing to endpoint: insufficient_permissions")))).toBe("error");
    expect(musicUnavailableReason("tiktok", toSocialError(new StreamableHTTPError(422, "Error POSTing to endpoint")))).toBe("error");
    expect(musicUnavailableReason("tiktok", toSocialError(new Error('{"status": 422, "detail": "not eligible"}')))).toBe("not_business");
    // A SocialError libi built itself, with no status from anywhere.
    expect(musicUnavailableReason("tiktok", new SocialError("validation", "bad args"))).toBe("error");
    expect(musicUnavailableReason("tiktok", new SocialError("provider", "x", { status: 400 }))).toBe("error");
  });

  it("maps not_found, a non-SocialError and unsupported", () => {
    expect(musicUnavailableReason("tiktok", toSocialError(new Error("Error: [404] account not found")))).toBe("error");
    expect(musicUnavailableReason("tiktok", new Error("socket hang up"))).toBe("error");
    expect(musicUnavailableReason("tiktok", "boom")).toBe("error");
    expect(musicUnavailableReason("tiktok", new SocialError("unsupported", "no such tool"))).toBe("unsupported");
    expect(musicUnavailableReason("instagram", new SocialError("unsupported", "no such tool"))).toBe("unsupported");
    expect(musicUnavailableReason("instagram", toSocialError(new Error("Error: [400] something else")))).toBe("error");
  });

  it("getCatalogTrack re-validates an Instagram track; a 404 is null", async () => {
    const { adapter } = adapterFor({
      instagram_get_instagram_audio: (a: Record<string, unknown>) => {
        if (a.audio_id === "482851939985510") return { audio: igAudio.audio[0] };
        throw toSocialError(new Error("Error: [404] Audio not found (code: not_found)"));
      },
    });
    expect(await adapter.getCatalogTrack!(IG, "482851939985510")).toMatchObject({ id: "482851939985510", title: "Summer Nights" });
    expect(await adapter.getCatalogTrack!(IG, "gone")).toBeNull();
  });

  it("musicAccountFacts: the probe maps tracks / refusals to facts, and a blip to nothing", async () => {
    const ok = adapterFor({ accounts_list_tik_tok_commercial_music: cml }).adapter;
    expect((await ok.musicAccountFacts(TT, "tiktok")).tiktokKind).toMatchObject({ value: "business", source: "detected" });
    const dev = adapterFor({ accounts_list_tik_tok_commercial_music: () => { throw toSocialError(new Error("Error: [403] not business app")); } }).adapter;
    expect((await dev.musicAccountFacts(TT, "tiktok")).tiktokKind?.value).toBe("personal");
    const blip = adapterFor({ accounts_list_tik_tok_commercial_music: () => { throw toSocialError(new Error("Error: [503] down")); } }).adapter;
    expect(await blip.musicAccountFacts(TT, "tiktok")).toEqual({});
    const ig = adapterFor({ instagram_search_instagram_audio: () => { throw toSocialError(new Error(IG_FB_LOGIN)); } }).adapter;
    expect((await ig.musicAccountFacts(IG, "instagram")).instagramFacebookLogin?.value).toBe(false);
  });
});
