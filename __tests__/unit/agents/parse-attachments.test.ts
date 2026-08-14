/**
 * Round-trip the `[Attached files]` block format produced by
 * `app/api/agent/send/route.ts:formatAttachments` so the chat UI can
 * reconstruct attachment parts after a session replay (page refresh).
 */
import { describe, it, expect } from "vitest";
import {
  extractAttachmentsBlock,
  applyAttachmentParsing,
} from "@/lib/agents/parse-attachments";
import type { AgentMessagePart } from "@/lib/agents/message-types";

describe("extractAttachmentsBlock", () => {
  it("returns the original text untouched when no block is present", () => {
    const text = "hi, please make a video";
    expect(extractAttachmentsBlock(text)).toEqual({ text, attachments: [] });
  });

  it("parses a single video attachment", () => {
    const text =
      "see the clip\n\n[Attached files]\n- clip.mp4 (video/mp4, 8.0 MB, 480x848, 49.6s) — fileId: abc-123";
    const result = extractAttachmentsBlock(text);
    expect(result.text).toBe("see the clip");
    expect(result.attachments).toEqual([
      {
        fileId: "abc-123",
        filename: "clip.mp4",
        contentType: "video/mp4",
        size: 8 * 1024 * 1024,
      },
    ]);
  });

  it("parses multiple attachments of mixed kinds", () => {
    const text =
      "[Attached files]\n" +
      "- a.png (image/png, 12 KB) — fileId: id-a\n" +
      "- b.mp4 (video/mp4, 8.0 MB, 1920x1080, 5.0s) — fileId: id-b\n" +
      "- c.mp3 (audio/mpeg, 4.0 MB, 30.0s) — fileId: id-c";
    // Not the canonical leading "\n\n", but lastIndexOf is permissive.
    const text2 = "x\n\n" + text;
    const result = extractAttachmentsBlock(text2);
    expect(result.text).toBe("x");
    expect(result.attachments.map((a) => a.fileId)).toEqual([
      "id-a",
      "id-b",
      "id-c",
    ]);
    expect(result.attachments.map((a) => a.contentType)).toEqual([
      "image/png",
      "video/mp4",
      "audio/mpeg",
    ]);
  });

  it("handles filenames that contain parentheses", () => {
    const text =
      "see\n\n[Attached files]\n- WhatsApp Video (1).mp4 (video/mp4, 1.0 MB, 480x848, 5.0s) — fileId: vid-1";
    const result = extractAttachmentsBlock(text);
    expect(result.attachments[0]).toMatchObject({
      filename: "WhatsApp Video (1).mp4",
      fileId: "vid-1",
      contentType: "video/mp4",
    });
  });

  it("preserves user text that comes BEFORE the block", () => {
    const text =
      "first line\nsecond line\n\n[Attached files]\n- a.png (image/png, 1 KB) — fileId: id";
    expect(extractAttachmentsBlock(text).text).toBe("first line\nsecond line");
  });

  it("treats a header without recognizable attachment lines as data, not block", () => {
    const text = "look at\n\n[Attached files]\nthis weird thing";
    const result = extractAttachmentsBlock(text);
    // No recognizable lines → leave the text alone so we don't mangle.
    expect(result.attachments).toEqual([]);
    expect(result.text).toBe(text);
  });

  it("falls back gracefully when size unit is unrecognized", () => {
    const text =
      "x\n\n[Attached files]\n- f.bin (??, ??) — fileId: idz";
    const result = extractAttachmentsBlock(text);
    expect(result.attachments[0]).toMatchObject({
      fileId: "idz",
      filename: "f.bin",
      // Unrecognized — falls through to 0 rather than crashing.
      size: 0,
    });
  });
});

describe("applyAttachmentParsing", () => {
  it("converts the block in a text part into separate file-attachment parts", () => {
    const parts: AgentMessagePart[] = [
      {
        type: "text",
        text:
          "look at this\n\n[Attached files]\n" +
          "- a.png (image/png, 12 KB) — fileId: id-a\n" +
          "- b.mp4 (video/mp4, 1.0 MB) — fileId: id-b",
      },
    ];
    const next = applyAttachmentParsing(parts);
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual({ type: "text", text: "look at this" });
    expect(next[1]).toMatchObject({
      type: "file-attachment",
      fileId: "id-a",
      filename: "a.png",
      contentType: "image/png",
    });
    expect(next[2]).toMatchObject({
      type: "file-attachment",
      fileId: "id-b",
      filename: "b.mp4",
      contentType: "video/mp4",
    });
  });

  it("drops the text part entirely when the message was attachment-only", () => {
    const parts: AgentMessagePart[] = [
      {
        type: "text",
        text:
          "\n\n[Attached files]\n- a.png (image/png, 1 KB) — fileId: id-a",
      },
    ];
    const next = applyAttachmentParsing(parts);
    expect(next).toHaveLength(1);
    expect(next[0].type).toBe("file-attachment");
  });

  it("returns the original array reference when nothing matches", () => {
    const parts: AgentMessagePart[] = [{ type: "text", text: "no block" }];
    expect(applyAttachmentParsing(parts)).toBe(parts);
  });

  it("leaves non-text parts (tool calls, thoughts) untouched", () => {
    const parts: AgentMessagePart[] = [
      { type: "thought", text: "thinking" },
      {
        type: "text",
        text:
          "go\n\n[Attached files]\n- a.png (image/png, 1 KB) — fileId: id-a",
      },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolId: null,
        rawTitle: "x",
        args: {},
      },
    ];
    const next = applyAttachmentParsing(parts);
    expect(next.find((p) => p.type === "thought")).toBeDefined();
    expect(next.find((p) => p.type === "tool-call")).toBeDefined();
    expect(next.find((p) => p.type === "file-attachment")).toBeDefined();
  });
});
