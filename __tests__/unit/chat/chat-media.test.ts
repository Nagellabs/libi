import { describe, it, expect } from "vitest";
import {
  classifyChatMedia,
  isShowInChatName,
  readChatMedia,
  extractChatMedia,
} from "@/lib/chat/chat-media";

describe("classifyChatMedia", () => {
  it("maps MIME prefixes to kinds", () => {
    expect(classifyChatMedia("image/png")).toBe("image");
    expect(classifyChatMedia("video/mp4")).toBe("video");
    expect(classifyChatMedia("audio/mpeg")).toBe("audio");
    expect(classifyChatMedia("application/pdf")).toBe("other");
  });
  it("is case-insensitive and handles null/empty", () => {
    expect(classifyChatMedia("IMAGE/JPEG")).toBe("image");
    expect(classifyChatMedia(null)).toBe("other");
    expect(classifyChatMedia(undefined)).toBe("other");
    expect(classifyChatMedia("")).toBe("other");
  });
});

describe("isShowInChatName", () => {
  it("matches dotted, colon, bare, and MCP-namespaced (underscore) tool names", () => {
    expect(isShowInChatName("libi.show_in_chat")).toBe(true);
    expect(isShowInChatName("libi:show_in_chat")).toBe(true);
    expect(isShowInChatName("show_in_chat")).toBe(true);
    // The form the live claude-code agent actually carries:
    expect(isShowInChatName("mcp__libi__libi_show_in_chat")).toBe(true);
    expect(isShowInChatName("libi.show_asset")).toBe(false);
    expect(isShowInChatName("myshow_in_chat_extra")).toBe(false);
    expect(isShowInChatName(null)).toBe(false);
    expect(isShowInChatName(undefined)).toBe(false);
  });
});

describe("readChatMedia", () => {
  const media = {
    fileId: "f1",
    kind: "image",
    contentType: "image/png",
    caption: "hi",
    filename: "a.png",
  };

  it("reads a payload nested under data", () => {
    expect(readChatMedia({ success: true, data: { chatMedia: media } })).toEqual(media);
  });
  it("reads a payload at the top level", () => {
    expect(readChatMedia({ chatMedia: media })).toEqual(media);
  });
  it("parses a JSON string result", () => {
    expect(readChatMedia(JSON.stringify({ data: { chatMedia: media } }))).toEqual(media);
  });
  it("unwraps the real MCP content-array shape (the reducer's actual shape)", () => {
    const mcpResult = {
      content: [{ type: "text", text: JSON.stringify({ success: true, data: { chatMedia: media } }) }],
    };
    expect(readChatMedia(mcpResult)).toEqual(media);
    // bare array form too
    expect(readChatMedia(mcpResult.content)).toEqual(media);
  });
  it("derives kind from contentType when kind is missing/invalid", () => {
    const r = readChatMedia({ data: { chatMedia: { fileId: "f", contentType: "video/mp4" } } });
    expect(r?.kind).toBe("video");
  });
  it("returns null for missing payload / unparseable / no fileId", () => {
    expect(readChatMedia({ success: true })).toBeNull();
    expect(readChatMedia("not json")).toBeNull();
    expect(readChatMedia(null)).toBeNull();
    expect(readChatMedia({ data: { chatMedia: { kind: "image" } } })).toBeNull();
  });
});

describe("extractChatMedia", () => {
  const result = { result: { data: { chatMedia: { fileId: "f1", kind: "audio", contentType: "audio/mpeg" } } } };

  it("emits the payload for a show_in_chat call with a result", () => {
    const r = extractChatMedia({ toolId: "libi.show_in_chat" }, result);
    expect(r).toMatchObject({ fileId: "f1", kind: "audio" });
  });
  it("matches via rawTitle too", () => {
    expect(extractChatMedia({ rawTitle: "show_in_chat" }, result)).not.toBeNull();
  });
  it("returns null for other tools", () => {
    expect(extractChatMedia({ toolId: "libi.show_asset" }, result)).toBeNull();
  });
  it("returns null when the result has not arrived yet", () => {
    expect(extractChatMedia({ toolId: "libi.show_in_chat" }, undefined)).toBeNull();
  });
});
