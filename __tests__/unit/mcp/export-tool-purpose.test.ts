import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 3461 }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { exportVideo, socialFitNote } from "@/mcp/tools/export-tools";

const MESSAGE = "This piece has copyrighted music (song.mp3). Ask the user what this export is for — a social post or personal use — then pass `purpose`. If they asked to post it, use libi.post_piece instead, which exports per platform.";

beforeEach(() => fetchMock.mockReset());

describe("libi.export_video — purpose", () => {
  it("relays the route's purpose_required refusal as a structured error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "purpose_required", message: MESSAGE }), { status: 422 }));
    const r = await exportVideo({ pieceId: "p1" });
    expect(r).toEqual({ success: false, data: { error: "purpose_required", hint: MESSAGE } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends purpose, copyrightedAudio and includeFileIds to the route", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await exportVideo({ pieceId: "p1", purpose: "social", copyrightedAudio: "exclude", includeFileIds: ["f1"] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ purpose: "social", copyrightedAudio: "exclude", includeFileIds: ["f1"] });
  });
});

describe("libi.export_video — a social export's size (agent-speed A4)", () => {
  it("socialFitNote speaks only when libi fitted the size, and names the size and the way out", () => {
    expect(socialFitNote({ socialFit: false }, { width: 2160, height: 3840 })).toBeUndefined();
    expect(socialFitNote(undefined, { width: 1, height: 1 })).toBeUndefined();
    const note = socialFitNote({ socialFit: true }, { width: 1080, height: 1920 })!;
    expect(note).toContain("1080×1920");
    expect(note).toContain('quality: "4k"');
  });

  it("passes no size of its own: the route decides it when the request names none", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await exportVideo({ pieceId: "p1", purpose: "social" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.quality).toBeUndefined();
    expect(body.graphicsQuality).toBeUndefined();
  });
});
