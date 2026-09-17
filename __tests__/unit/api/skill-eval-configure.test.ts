import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb } from "@/__tests__/helpers/test-db";

vi.mock("@/mcp/workspace", () => ({ prepareAgentDir: vi.fn(async () => {}) }));
const switchAgent = vi.fn(async () => {});
const createStandbySession = vi.fn(async () => {});
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({ switchAgent, createStandbySession }),
}));
vi.mock("@/lib/security/test-routes", () => ({ testRoutesEnabled: () => true }));

import { POST } from "@/app/api/skill-eval/configure/route";
import {
  getMcpServersForAcp,
  invalidateMcpConfig,
  setTestModeFakesEnabled,
  testModeFakesEnabled,
} from "@/lib/mcp-config";

const post = (body: unknown) =>
  new Request("http://x/api/skill-eval/configure", { method: "POST", body: JSON.stringify(body) });

const acpNames = (agent: string) =>
  getMcpServersForAcp(agent).map((e) => (e as { name: string }).name);

// The aggregator is not running in a unit test; `notifyMcpHttpReload` is
// fire-and-forget, so a rejected fetch is the normal case here. The spy is
// what the reload-count assertions read.
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("no aggregator in tests"),
  ) as unknown as ReturnType<typeof vi.fn>;
  createTestDb();
  fs.writeFileSync(path.join(process.env.LIBI_HOME!, "mcp-port"), "3999");
  // The harness always boots the hermetic libi with LIBI_TEST_MODE=1; the
  // fakes only exist in test mode, so that is the route's normal environment.
  process.env.LIBI_TEST_MODE = "1";
  setTestModeFakesEnabled(true); // process-level flag — reset it between cases
  invalidateMcpConfig({ reason: "test" });
  switchAgent.mockClear();
  createStandbySession.mockClear();
});
afterEach(() => {
  delete process.env.LIBI_TEST_MODE;
  setTestModeFakesEnabled(true);
  invalidateMcpConfig({ reason: "test-cleanup" });
  fetchSpy.mockRestore();
});

describe("POST /api/skill-eval/configure", () => {
  it("accepts fal-ai and ElevenLabs as the ACP-injected fakes and leaves them attached", async () => {
    const res = await POST(post({ skills: [], mcps: ["fal-ai", "ElevenLabs"], agent: "claude-code" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fakes).toEqual(["fal-ai", "ElevenLabs"]);
    expect(body.extensions).toEqual([]);
    expect(testModeFakesEnabled()).toBe(true);
    expect(acpNames("claude-code")).toEqual(["libi", "fal-ai", "ElevenLabs"]);
  });

  it("resolves libi extension ids", async () => {
    const res = await POST(post({ skills: [], mcps: ["youtube-download", "whisper"], agent: "claude-code" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensions).toEqual(["youtube-download", "whisper"]);
    expect(body.fakes).toEqual([]);
  });

  /**
   * The flag used to be `mcps.length > 0`, so an extension-only list —
   * which names no fake-backed provider at all — silently attached fal-ai AND
   * ElevenLabs. A scenario written to prove "the agent has libi's tracking
   * extension and NO remote provider" then ran with a remote provider in front
   * of it, and its provider-gate behaviour tested nothing. The pair semantics
   * are unchanged; what decides is whether a listed name resolves to a fake.
   */
  it("does NOT attach the fakes for an extension-only list", async () => {
    const res = await POST(post({ skills: [], mcps: ["libi-tracking"], agent: "claude-code" }));
    expect(res.status).toBe(200);
    expect((await res.json()).extensions).toEqual(["libi-tracking"]);
    expect(testModeFakesEnabled()).toBe(false);
    expect(acpNames("claude-code")).toEqual(["libi"]);
  });

  it("attaches BOTH fakes when the list names either one, alongside an extension", async () => {
    const res = await POST(post({ skills: [], mcps: ["libi-tracking", "ElevenLabs"], agent: "claude-code" }));
    expect(res.status).toBe(200);
    expect(testModeFakesEnabled()).toBe(true);
    expect(acpNames("claude-code")).toEqual(["libi", "fal-ai", "ElevenLabs"]);
  });

  it("resolves an extension by display name", async () => {
    const res = await POST(post({ skills: [], mcps: ["Whisper (local STT)", "Local TTS (Kokoro)"], agent: "claude-code" }));
    expect(res.status).toBe(200);
    expect((await res.json()).extensions).toEqual(["whisper", "local-tts"]);
  });

  // The two scenarios that pre-date the youtube-download extension named the removed yt-dlp MCP by its
  // old row name; that name now means the youtube-download extension
  // (libi.download_video).
  it("maps the legacy 'YouTube Downloader' name to the youtube-download extension", async () => {
    const res = await POST(post({ skills: [], mcps: ["YouTube Downloader", "fal-ai"], agent: "claude-code" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensions).toEqual(["youtube-download"]);
    expect(body.fakes).toEqual(["fal-ai"]);
  });

  it("400s on a name the harness cannot provide, naming it", async () => {
    const res = await POST(post({ skills: [], mcps: ["fal-ai", "some-random-mcp"], agent: "claude-code" }));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    // Only the unprovidable name is listed — fal-ai resolved fine.
    expect(error).toMatch(/cannot provide these MCPs: some-random-mcp\./i);
    expect(switchAgent).not.toHaveBeenCalled();
  });

  it("409s outside test mode — the fakes only exist there", async () => {
    delete process.env.LIBI_TEST_MODE;
    const res = await POST(post({ skills: [], mcps: ["fal-ai"], agent: "claude-code" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/LIBI_TEST_MODE/);
    expect(switchAgent).not.toHaveBeenCalled();
  });

  // The `mcps: []` contract. Plan C's _meta/no-provider scenario depends on
  // exactly this behaviour, and it is the ONLY agent-level test of the
  // provider gate. If this goes red, that scenario has silently stopped
  // testing anything.
  it("detaches the test-mode fakes when the scenario lists no MCP", async () => {
    const res = await POST(post({ skills: [], mcps: [], agent: "claude-code" }));
    expect(res.status).toBe(200);
    expect(testModeFakesEnabled()).toBe(false);
    expect(acpNames("claude-code")).toEqual(["libi"]);
  });

  it("attaches them again when the next scenario lists one", async () => {
    await POST(post({ skills: [], mcps: [], agent: "claude-code" }));
    expect(acpNames("claude-code")).toEqual(["libi"]);
    await POST(post({ skills: [], mcps: ["fal-ai"], agent: "claude-code" }));
    expect(testModeFakesEnabled()).toBe(true);
    expect(acpNames("claude-code")).toEqual(["libi", "fal-ai", "ElevenLabs"]);
  });

  /**
   * Every invalidation is a cache rebuild AND a `/reload` round-trip to
   * the aggregator child. `setTestModeFakesEnabled` already invalidates when
   * the value moves, so the route's own unconditional call made a configure
   * that flipped the flag pay for two of each.
   */
  it("invalidates once per configure, whether or not the flag flips", async () => {
    const reloads = () =>
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/reload")).length;

    fetchSpy.mockClear();
    await POST(post({ skills: [], mcps: [], agent: "claude-code" })); // flips true → false
    expect(reloads()).toBe(1);

    fetchSpy.mockClear();
    await POST(post({ skills: [], mcps: [], agent: "claude-code" })); // no change
    expect(reloads()).toBe(1);
  });

  it("tells the aggregator which fakes are attached, so its banner can match", async () => {
    fetchSpy.mockClear();
    await POST(post({ skills: [], mcps: [], agent: "claude-code" }));
    const body = JSON.parse(
      String(
        (fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/reload"))![1] as RequestInit)
          .body,
      ),
    );
    expect(body.testModeFakes).toBe(false);

    fetchSpy.mockClear();
    await POST(post({ skills: [], mcps: ["fal-ai"], agent: "claude-code" }));
    const onBody = JSON.parse(
      String(
        (fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/reload"))![1] as RequestInit)
          .body,
      ),
    );
    expect(onBody.testModeFakes).toBe(true);
  });

  it("flips the flag before the standby is rebuilt, so the standby sees the new list", async () => {
    let flagWhenStandbyBuilt: boolean | undefined;
    createStandbySession.mockImplementationOnce(async () => {
      flagWhenStandbyBuilt = testModeFakesEnabled();
    });
    await POST(post({ skills: [], mcps: [], agent: "claude-code" }));
    expect(flagWhenStandbyBuilt).toBe(false);
    expect(switchAgent).toHaveBeenCalledWith("claude-code");
  });
});
