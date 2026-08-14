/**
 * `cleanUserMessageParts` is invoked when a user message is finalized
 * during loadSession replay. It needs to:
 *
 *   1. Strip Claude Code's `<command-name>` slash-command XML (existing).
 *   2. Pull the inline `[Attached files]` block out of the text and
 *      synthesize structured `file-attachment` parts (new — supports
 *      page-refresh thumbnail rendering).
 */
import { describe, it, expect } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { AgentMessage } from "@/lib/agents/message-types";

let counter = 0;
function newHandler() {
  return new SessionEventHandler(
    { next: () => counter++ },
    () => {},
    () => undefined,
  );
}

function userMsg(text: string): AgentMessage {
  return {
    id: `u${counter++}`,
    role: "user",
    parts: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

describe("cleanUserMessageParts — attachments block", () => {
  it("converts the [Attached files] block into file-attachment parts", () => {
    const handler = newHandler();
    const msg = userMsg(
      "see the clip\n\n[Attached files]\n" +
        "- clip.mp4 (video/mp4, 8.0 MB, 480x848, 49.6s) — fileId: id-1\n" +
        "- a.png (image/png, 1 KB) — fileId: id-2",
    );

    handler.cleanUserMessageParts(msg);

    expect(msg.parts).toHaveLength(3);
    expect(msg.parts[0]).toEqual({ type: "text", text: "see the clip" });
    expect(msg.parts[1]).toMatchObject({
      type: "file-attachment",
      fileId: "id-1",
      filename: "clip.mp4",
      contentType: "video/mp4",
    });
    expect(msg.parts[2]).toMatchObject({
      type: "file-attachment",
      fileId: "id-2",
      filename: "a.png",
      contentType: "image/png",
    });
  });

  it("still strips slash-command XML alongside attachments", () => {
    const handler = newHandler();
    const msg = userMsg(
      "<command-name>/model</command-name>foo<local-command-stdout>x</local-command-stdout>" +
        "real text\n\n[Attached files]\n- a.mp3 (audio/mpeg, 1 MB) — fileId: id-a",
    );

    handler.cleanUserMessageParts(msg);

    // Slash-command XML is stripped, leaving "real text" + the attachment part.
    const textParts = msg.parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe("real text");
    const attach = msg.parts.find((p) => p.type === "file-attachment");
    expect(attach).toMatchObject({ fileId: "id-a", filename: "a.mp3" });
  });

  it("leaves a plain message without attachments untouched", () => {
    const handler = newHandler();
    const msg = userMsg("just text, nothing fancy");
    handler.cleanUserMessageParts(msg);
    expect(msg.parts).toEqual([{ type: "text", text: "just text, nothing fancy" }]);
  });

  it("drops the empty text part when the message was attachments-only", () => {
    const handler = newHandler();
    const msg = userMsg(
      "\n\n[Attached files]\n- only.mp4 (video/mp4, 1 MB) — fileId: id-only",
    );
    handler.cleanUserMessageParts(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0].type).toBe("file-attachment");
  });
});
