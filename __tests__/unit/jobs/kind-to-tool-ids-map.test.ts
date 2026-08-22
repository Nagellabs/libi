import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRunnerRegistryForTests,
  registerBuiltinRunners,
  getJobKindToToolIdsMap,
} from "@/lib/jobs/runners/registry";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

describe("getJobKindToToolIdsMap", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    registerBuiltinRunners();
  });

  it("returns kind → array of canonical IDs for every UI-facing runner", () => {
    const map = getJobKindToToolIdsMap();
    expect(map.get("music_generate")).toEqual([
      makeMcpToolId("libi", "libi.generate_music"),
    ]);
    expect(map.get("tracking")).toEqual([
      makeMcpToolId("libi", "libi.compute_object_track"),
      makeMcpToolId("libi-tracking", "libi.compute_object_track"),
    ]);
    expect(map.get("tracking_provider")).toEqual([
      makeMcpToolId("libi", "libi.compute_object_track_providers"),
      makeMcpToolId("libi-tracking", "libi.compute_object_track_providers"),
    ]);
    expect(map.get("whisper_model_download")).toEqual([
      makeMcpToolId("libi", "libi.whisper_download_model"),
    ]);
    expect(map.get("tts_model_download")).toEqual([
      makeMcpToolId("libi", "libi.tts_download_model"),
    ]);
    expect(map.get("music_model_download")).toEqual([
      makeMcpToolId("libi", "libi.music_download_model"),
    ]);
    expect(map.get("remote_fetch")).toEqual([
      makeMcpToolId("libi", "libi.import_remote_files"),
    ]);
    expect(map.get("tracking_engine_install")).toEqual([
      makeMcpToolId("libi", "libi.install_tracking_engine"),
    ]);
  });

  it("excludes server-internal runners (no mcpToolId)", () => {
    const map = getJobKindToToolIdsMap();
    expect(map.has("proxy_gen")).toBe(false);
    expect(map.has("analysis_describe_frame")).toBe(false);
    expect(map.has("export_render")).toBe(false);
  });

  it("always normalizes to array form even for single-ID runners", () => {
    const map = getJobKindToToolIdsMap();
    const ids = map.get("music_generate");
    expect(Array.isArray(ids)).toBe(true);
    expect(ids?.length).toBe(1);
  });
});
