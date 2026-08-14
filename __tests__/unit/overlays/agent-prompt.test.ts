import { describe, it, expect } from "vitest";
import {
  buildCreatePrompt,
  buildModifyPrompt,
  buildTranscribePrompt,
} from "@/lib/overlays/agent-prompt";

describe("agent prompt builders", () => {
  it("create includes kind + time + description", () => {
    const p = buildCreatePrompt("three", "a spinning logo", { startTime: 2 });
    expect(p).toContain("3D");
    expect(p).toContain("2");
    expect(p).toContain("a spinning logo");
  });
  it("create with empty description still produces a usable scaffold", () => {
    const p = buildCreatePrompt("code", "", { startTime: 0 });
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain("code");
  });
  it("create quotes the exact timecode (matching the selector) + precise seconds", () => {
    // 71 frames @ 30fps = 2.3667s → timeline shows 00:02:11; the prompt must
    // lead with that timecode and give the unrounded seconds, not "2.4s".
    const p = buildCreatePrompt("three", "", { startTime: 71 / 30, timecode: "00:02:11" });
    expect(p).toContain("00:02:11");
    expect(p).toContain("2.37s");
    expect(p).not.toContain("2.4s");
  });
  it("create without a timecode falls back to precise seconds", () => {
    const p = buildCreatePrompt("code", "", { startTime: 1.234 });
    expect(p).toContain("1.23s");
  });
  it("modify includes overlay id + kind + description", () => {
    const p = buildModifyPrompt({ id: "ov1", kind: "text", content: "Hi" }, "make it gold");
    expect(p).toContain("ov1");
    expect(p).toContain("make it gold");
  });
  it("modify without content omits the text hint cleanly", () => {
    const p = buildModifyPrompt({ id: "ov2", kind: "image" }, "move it left");
    expect(p).toContain("ov2");
    expect(p).toContain("move it left");
  });
  it("transcribe includes the file id, file name, and a transcribe instruction", () => {
    const p = buildTranscribePrompt({ fileId: "f9", fileName: "intro-vo.mp3", label: "intro VO" });
    expect(p).toContain("f9");
    expect(p).toContain("intro-vo.mp3");
    expect(p).toContain("intro VO");
    expect(p.toLowerCase()).toContain("transcribe");
  });
  it("transcribe works without a label", () => {
    const p = buildTranscribePrompt({ fileId: "f1", fileName: "music.wav" });
    expect(p).toContain("music.wav");
    expect(p.toLowerCase()).toContain("transcribe");
  });
});
