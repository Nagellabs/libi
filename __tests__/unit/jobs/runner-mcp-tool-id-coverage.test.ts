import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRunnerRegistryForTests,
  registerBuiltinRunners,
  listRunners,
  getRunner,
} from "@/lib/jobs/runners/registry";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

describe("Runner mcpToolId coverage", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    registerBuiltinRunners();
  });

  it("UI-facing runners declare expected mcpToolId(s)", () => {
    const expected: Record<string, string | string[]> = {
      tracking: [
        makeMcpToolId("libi", "libi.compute_object_track"),
        makeMcpToolId("libi-tracking", "libi.compute_object_track"),
      ],
      tracking_provider: [
        makeMcpToolId("libi", "libi.compute_object_track_providers"),
        makeMcpToolId("libi-tracking", "libi.compute_object_track_providers"),
      ],
      matte_gen: [
        makeMcpToolId("libi", "libi.remove_background"),
        makeMcpToolId("libi-tracking", "libi.remove_background"),
      ],
      music_generate: makeMcpToolId("libi", "libi.generate_music"),
      whisper_model_download: makeMcpToolId("libi", "libi.whisper_download_model"),
      music_model_download: makeMcpToolId("libi", "libi.music_download_model"),
      tts_model_download: makeMcpToolId("libi", "libi.tts_download_model"),
      extra_analysis_model: makeMcpToolId("libi", "libi.extra_analysis_model"),
      tracking_engine_install: makeMcpToolId(
        "libi",
        "libi.install_tracking_engine",
      ),
      remote_fetch: makeMcpToolId("libi", "libi.import_remote_files"),
      dev_slow: makeMcpToolId("libi", "libi.dev_slow_job"),
    };

    for (const [kind, want] of Object.entries(expected)) {
      const runner = getRunner(kind);
      expect(runner, `runner for kind=${kind}`).toBeTruthy();
      expect(runner?.mcpToolId, `mcpToolId for kind=${kind}`).toEqual(want);
    }
  });

  it("server-internal runners have no mcpToolId", () => {
    expect(getRunner("proxy_gen")?.mcpToolId).toBeUndefined();
    // filmstrip_gen is server-internal (timeline sprite gen on upload) — no
    // chat surface, so no mcpToolId.
    expect(getRunner("filmstrip_gen")?.mcpToolId).toBeUndefined();
    expect(getRunner("analysis_describe_frame")?.mcpToolId).toBeUndefined();
    expect(getRunner("export_render")?.mcpToolId).toBeUndefined();
    // piece_dup is fire-and-forget: duplicate_piece returns a jobId immediately
    // and the agent polls get_job_status — no chat-progress surface.
    expect(getRunner("piece_dup")?.mcpToolId).toBeUndefined();
  });

  it("listRunners returns the full set", () => {
    const kinds = listRunners().map((r) => r.kind).sort();
    expect(kinds).toContain("tracking");
    expect(kinds).toContain("music_generate");
    expect(kinds).toContain("proxy_gen");
  });
});
