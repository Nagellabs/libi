/**
 * analysis_save frames / summary: zod reports a nested payload one layer at a time, so a refused call
 * returns the whole minimal shape (and the advertised property text carries it too).
 */
import { describe, it, expect } from "vitest";
import { actionRunnerFor } from "@/mcp/tools/action-tool";
import { analysisSaveTool, FRAME_SHAPE_SKELETON, SUMMARY_SHAPE_SKELETON } from "@/mcp/tools/families/analysis";
import { frameDescriptionSchema, videoSummarySchema } from "@/lib/analysis/schemas";
import { renderAgentInstructions } from "@/mcp/workspace";
import { resolveManualSection } from "@/mcp/manual-sections";

describe("analysis_save: a refused frames / summary returns the shape", () => {
  const { run } = actionRunnerFor(analysisSaveTool);

  it("the skeletons are themselves valid", () => {
    const frame = new Function(`return (${FRAME_SHAPE_SKELETON})`)() as { description: unknown };
    expect(frameDescriptionSchema.safeParse(frame.description).success).toBe(true);
    const summary = new Function(`return (${SUMMARY_SHAPE_SKELETON})`)();
    expect(videoSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("frames: names the full failing path and carries the frame_v1 skeleton", async () => {
    const out = await run(
      "frames",
      { fileId: "f", frames: [{ frameIndex: 0, timestamp: 0, filePath: "frame-0001.png", description: { schema_version: "frame_v1", frame_index: 0, timestamp: 0, scene: "x" } }] },
      undefined,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("frames.0.description.setting");
    expect(out.error).toContain(FRAME_SHAPE_SKELETON);
    expect(out.error).toMatch(/references\/shapes\.md/);
  });

  it("frames: a description sent as a string is refused with the skeleton", async () => {
    const out = await run(
      "frames",
      { fileId: "f", frames: [{ frameIndex: 0, timestamp: 0, filePath: "a.png", description: "a man walks" }] },
      undefined,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("frames.0.description");
      expect(out.error).toContain('"frame_v1"');
    }
  });

  it("summary: names the path and carries the video_v1 skeleton", async () => {
    const out = await run("summary", { fileId: "f", summary: { schema_version: "video_v1", overview: "x", duration: 3 } }, undefined);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("summary.subjects");
    expect(out.error).toContain(SUMMARY_SHAPE_SKELETON);
  });

  it("a refusal that is not about the payload (a missing fileId) carries no skeleton", async () => {
    const out = await run("summary", { summary: JSON.parse(JSON.stringify(new Function(`return (${SUMMARY_SHAPE_SKELETON})`)())) }, undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("fileId");
      expect(out.error).not.toContain("Minimal valid value");
    }
  });

  it("the advertised frames / summary properties carry the skeleton and a path an agent without the skill can read", async () => {
    const { buildFlatSchema } = await import("@/mcp/tools/action-tool");
    const flat = buildFlatSchema(analysisSaveTool, "action", Object.keys(analysisSaveTool.actions));
    const frames = (flat.shape.frames as { description?: string }).description ?? "";
    const summary = (flat.shape.summary as { description?: string }).description ?? "";
    expect(frames).toContain('"frame_v1"');
    expect(summary).toContain('"video_v1"');
    for (const text of [frames, summary]) expect(text).toContain('libi.read_manual({ section: "canvas-dimensions" })');

    // …and that section really holds the shapes, in both dialects.
    for (const dialect of ["claude", "codex"] as const) {
      const res = resolveManualSection(renderAgentInstructions(dialect), "canvas-dimensions");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.text).toContain("Schemas (frame_v1, video_v1)");
        expect(res.text).toContain('schema_version: "video_v1"');
      }
    }
  });
});
