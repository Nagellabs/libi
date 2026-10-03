import { describe, it, expect } from "vitest";
import {
  formatToolId,
  formatBuiltinTitle,
  extractResultText,
  extractResultPreview,
  formatSubagentResult,
} from "@/lib/agents/format-tool-name";
import { makeMcpToolId, fromAnyToolName } from "@/lib/agents/mcp-tool-id";

describe("formatToolId", () => {
  it("formats libi tools by stripping prefix + title-casing", () => {
    expect(formatToolId(makeMcpToolId("libi", "libi.remove_background")))
      .toBe("Libi Remove background");
    expect(formatToolId(makeMcpToolId("libi", "libi.analysis_describe_frame")))
      .toBe("Libi Analysis describe frame");
    expect(formatToolId(makeMcpToolId("libi", "libi.analysis_transcribe_audio")))
      .toBe("Libi Analysis transcribe audio");
    expect(formatToolId(makeMcpToolId("libi", "libi.create_piece")))
      .toBe("Libi Create piece");
    expect(formatToolId(makeMcpToolId("libi", "libi.list_pieces")))
      .toBe("Libi List pieces");
  });

  // codex-acp's rawInput for an MCP call is `{ server, tool, arguments }`: the action is one level down.
  it("names the action of a merged libi tool from codex's { server, tool, arguments } envelope too", () => {
    const snapshot = makeMcpToolId("libi", "libi.snapshot");
    const env = (args: unknown) => ({ server: "libi", tool: "libi.snapshot", arguments: args });
    expect(formatToolId(snapshot, env({ action: "discard", pieceId: "p", confirm: true }))).toBe("Libi Snapshot · discard");
    expect(formatToolId(makeMcpToolId("libi", "libi.show"), { server: "libi", tool: "libi.show", arguments: { target: "templates" } })).toBe("Libi Show · templates");
    expect(formatToolId(snapshot, env({ pieceId: "p" }))).toBe("Libi Snapshot");
    expect(formatToolId(snapshot, { server: "libi", tool: "libi.snapshot" })).toBe("Libi Snapshot");
    // a tool whose OWN arguments happen to be named server/tool/arguments with no object inside is not unwrapped
    expect(formatToolId(snapshot, { server: "x", tool: "y", arguments: "z", action: "discard" })).toBe("Libi Snapshot · discard");
    // an unmerged tool never names an action, wrapped or not
    expect(formatToolId(makeMcpToolId("libi", "libi.list_pieces"), { server: "libi", tool: "libi.list_pieces", arguments: { action: "x" } })).toBe("Libi List pieces");
  });

  it("names the action of a merged libi tool when the call's args are given", () => {
    const keyframe = makeMcpToolId("libi", "libi.keyframe");
    expect(formatToolId(keyframe)).toBe("Libi Keyframe");
    expect(formatToolId(keyframe, { action: "set_easing", pieceId: "p" })).toBe("Libi Keyframe · set easing");
    // `libi.show` discriminates on `target`, not `action`
    expect(formatToolId(makeMcpToolId("libi", "libi.show"), { target: "export", pieceId: "p" })).toBe("Libi Show · export");
    // a call that has not streamed its args yet, or sent junk, keeps the plain label
    expect(formatToolId(keyframe, {})).toBe("Libi Keyframe");
    expect(formatToolId(keyframe, { action: "Not A Shape!" })).toBe("Libi Keyframe");
    // an ordinary tool ignores an `action` arg it happens to carry
    expect(formatToolId(makeMcpToolId("libi", "libi.create_piece"), { action: "list" })).toBe("Libi Create piece");
  });

  it("treats libi-tracking the same as libi (shared 'Libi' brand)", () => {
    expect(formatToolId(makeMcpToolId("libi-tracking", "libi.track")))
      .toBe("Libi Track");
    expect(formatToolId(makeMcpToolId("libi-tracking", "libi.track"), { action: "compute_segment" }))
      .toBe("Libi Track · compute segment");
    expect(formatToolId(makeMcpToolId("libi", "libi.analysis_save"), { action: "audio_chunk_from_file" }))
      .toBe("Libi Analysis save · audio chunk from file");
  });

  it("formats non-libi tools as <serverLabel> <Action>", () => {
    // The user's own provider MCPs (libi bundles none): mixed-case names keep
    // their casing, all-lowercase names get a capital.
    expect(formatToolId(makeMcpToolId("ElevenLabs", "speech_to_text")))
      .toBe("ElevenLabs Speech to text");
    expect(formatToolId(makeMcpToolId("YouTube_Downloader", "ytdlp_download_audio")))
      .toBe("YouTube Downloader Ytdlp download audio");
    expect(formatToolId(makeMcpToolId("fal-ai", "generate_image")))
      .toBe("Fal-ai Generate image");
  });

  // ElevenLabs' hosted server (catalog entry `elevenlabs`, 2026-09-25) prefixes every creative tool with
  // `creative_`; the chat reads "ElevenLabs Generate speech", not "Elevenlabs Creative generate speech".
  it("labels ElevenLabs' hosted tools by what they do, under the provider's own spelling", () => {
    expect(formatToolId(makeMcpToolId("elevenlabs", "creative_generate_speech"))).toBe("ElevenLabs Generate speech");
    expect(formatToolId(makeMcpToolId("elevenlabs", "creative_get_flow_run_status"))).toBe("ElevenLabs Get flow run status");
    expect(formatToolId(makeMcpToolId("elevenlabs", "creative_list_voices"))).toBe("ElevenLabs List voices");
    // A user's own entry spelled `ElevenLabs` (and test mode's fake before 2026-09-25): the same labels.
    expect(formatToolId(makeMcpToolId("ElevenLabs", "creative_generate_in_flow"))).toBe("ElevenLabs Generate in flow");
    // An older local server's names keep reading as before.
    expect(formatToolId(makeMcpToolId("elevenlabs", "text_to_speech"))).toBe("ElevenLabs Text to speech");
    // Another server's `creative_` tool is not ElevenLabs'.
    expect(formatToolId(makeMcpToolId("my_server", "creative_thing"))).toBe("My server Creative thing");
  });

  it("uses the bundled display name for canonical bundled ids", () => {
    // fromAnyToolName canonicalizes bundled servers to their bundled id —
    // the label must come from the def's display name, not the raw id.
    expect(formatToolId(makeMcpToolId("whisper", "whisper_transcribe")))
      .toBe("Whisper (local STT) Whisper transcribe");
    expect(formatToolId(makeMcpToolId("local-tts", "tts_list_voices")))
      .toBe("Local TTS (Kokoro) Tts list voices");
  });

  // The in-app ACP entry is `libi-app` (IN_APP_MCP_NAME); fromAnyToolName
  // aliases that wire segment to the `libi` server id, so the chat label
  // must be byte-identical to the one a `libi connect` session produces.
  it("labels the in-app libi-app wire name exactly like the libi one", () => {
    const inApp = formatToolId(fromAnyToolName("mcp__libi-app__libi_list_pieces")!);
    const connect = formatToolId(fromAnyToolName("mcp__libi__libi_list_pieces")!);
    expect(inApp).toBe("Libi List pieces");
    expect(inApp).toBe(connect);
  });

  it("prettifies unknown (user-installed) server ids generically", () => {
    // Mixed-case segments are user-chosen names — preserve their casing.
    expect(formatToolId(makeMcpToolId("My_Custom_MCP", "do_thing")))
      .toBe("My Custom MCP Do thing");
    // All-lowercase names get a leading capital.
    expect(formatToolId(makeMcpToolId("my_server", "do_thing")))
      .toBe("My server Do thing");
  });
});

describe("formatBuiltinTitle", () => {
  it("passes built-in titles through unchanged", () => {
    expect(formatBuiltinTitle("Read /tmp/foo.txt")).toBe("Read /tmp/foo.txt");
    expect(formatBuiltinTitle("grep -i 'pattern' /path")).toBe("grep -i 'pattern' /path");
    expect(formatBuiltinTitle("ToolSearch")).toBe("ToolSearch");
    expect(formatBuiltinTitle("Bash(npm test)")).toBe("Bash(npm test)");
  });
});

describe("extractResultText", () => {
  it("returns null for empty/nullish results", () => {
    expect(extractResultText(null)).toBeNull();
    expect(extractResultText(undefined)).toBeNull();
    expect(extractResultText("")).toBeNull();
    expect(extractResultText("   ")).toBeNull();
  });

  it("returns string results trimmed", () => {
    expect(extractResultText("hello")).toBe("hello");
    expect(extractResultText("  hi  ")).toBe("hi");
  });

  it("joins MCP content arrays", () => {
    const result = {
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    };
    expect(extractResultText(result)).toBe("first line\nsecond line");
  });

  it("ignores non-text content blocks", () => {
    const result = {
      content: [
        { type: "image", url: "https://example/x.png" },
        { type: "text", text: "found 3 results" },
      ],
    };
    expect(extractResultText(result)).toBe("found 3 results");
  });

  it("handles bare content arrays from claude-agent-acp", () => {
    const result = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractResultText(result)).toBe("hello\nworld");
  });

  it("peels libi success/data envelope and summarizes the count", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          data: { pieces: [{ id: "abc", name: "Test" }] },
        }),
      },
    ];
    // Single-key wrapper around an array → friendly singular summary.
    expect(extractResultText(result)).toBe("1 piece");
  });

  it("surfaces libi error string on failure envelope", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify({ success: false, error: "piece not found" }),
      },
    ];
    expect(extractResultText(result)).toBe("piece not found");
  });

  it("returns 'ok' for libi success with no data", () => {
    const result = [{ type: "text", text: JSON.stringify({ success: true }) }];
    expect(extractResultText(result)).toBe("ok");
  });

  it("summarizes count for structured arrays (e.g. ToolSearch)", () => {
    const result = [
      { type: "tool_reference", tool_name: "mcp__libi__libi_list_pieces" },
      { type: "tool_reference", tool_name: "mcp__libi__libi_create_piece" },
    ];
    // Bare array of objects → "N items · <highlight of first>". The
    // first item has no `name`/`title`/etc., so the renderer falls back
    // to the first non-id scalars: type + tool_name.
    expect(extractResultText(result)).toContain("2 items");
    expect(extractResultText(result)).toContain("tool_reference");
  });

  it("pretty-prints non-enveloped JSON text (skill-tools shape)", () => {
    // listMcpServersTool wraps its payload via a local ok() helper that
    // doesn't add the {success, data} envelope — the text block is just
    // compact JSON. We should still pretty-print it.
    const result = [
      {
        type: "text",
        text: JSON.stringify({
          servers: [{ id: "libi", name: "Libi" }],
        }),
      },
    ];
    expect(extractResultText(result)).toBe("1 server");
  });

  it("summarizes multi-array shapes with counts", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          data: { results: [1, 2, 3, 4, 5], errors: [{ msg: "x" }, { msg: "y" }] },
        }),
      },
    ];
    expect(extractResultText(result)).toBe("5 results, 2 errors");
  });

  it("falls back to data field when result is an object envelope", () => {
    expect(extractResultText({ success: true, data: "ok" })).toBe("ok");
    // Single-key data → summarized.
    expect(
      extractResultText({ success: true, data: { id: "abc" } }),
    ).toBe("id: abc");
  });

  it("returns null when stringification yields just '{}'", () => {
    expect(extractResultText({})).toBeNull();
  });

  it("reports kind=summary for short payloads, kind=block for long ones", () => {
    expect(extractResultPreview("ok")?.kind).toBe("summary");
    expect(extractResultPreview({ servers: [{ id: "a" }] })?.kind).toBe("summary");
    // A multi-line raw-text payload should render as a block.
    const longText = "line1\nline2\nline3";
    expect(extractResultPreview(longText)?.kind).toBe("block");
  });

  // -------------------------------------------------------------------
  // Generic object summarisation — never fall back to JSON
  // -------------------------------------------------------------------

  it("create_piece-shaped {id, name, description} → headline · description", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          data: {
            id: "1eddec21-1be5-4749-9423",
            name: "Mimic Video Project",
            description: "Analysis-driven recreation of a reference video",
          },
        }),
      },
    ];
    const preview = extractResultPreview(result);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toContain("Mimic Video Project");
    expect(preview?.text).toContain("Analysis-driven recreation");
    expect(preview?.text).not.toContain("{");
  });

  it("analysis_start-shaped {analysisId, fileId} → key: value (id-only fallback)", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          data: {
            analysisId: "bff24569-c0c7-4779-b35d-1e786d564ae4",
            fileId: "4c90562a-6bdd-4331-9e5a-b8c23fb63fbf",
          },
        }),
      },
    ];
    const preview = extractResultPreview(result);
    expect(preview?.kind).toBe("summary");
    // Both fields are id-like — fall back to a key: value list.
    expect(preview?.text).toMatch(/analysisId: |fileId: /);
    expect(preview?.text).not.toContain("{");
  });

  it("analysis_extract_audio-shaped {analysisId, path} → path headline", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          data: {
            analysisId: "bff24569",
            path: "/Users/x/.libi/storage/abc/_analysis/1/audio.wav",
          },
        }),
      },
    ];
    const preview = extractResultPreview(result);
    expect(preview?.kind).toBe("summary");
    // `path` is a HIGHLIGHT field — should anchor the summary.
    expect(preview?.text).toContain("audio.wav");
    expect(preview?.text).not.toContain("{");
  });

  it("array of frame_v1 objects → '1 item · scene: …'", () => {
    const result = [
      {
        type: "text",
        text: JSON.stringify([
          {
            schema_version: "frame_v1",
            frame_index: 0,
            timestamp: 2.482,
            scene: "A blonde woman in a black blazer works on a laptop",
          },
        ]),
      },
    ];
    const preview = extractResultPreview(result);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toContain("1 item");
    // The scene-content highlight makes it through (clipped) — a far
    // more useful preview than `frame_index, timestamp` would have been.
    expect(preview?.text).toContain("blonde woman");
    expect(preview?.text).not.toContain("{");
    expect(preview?.text).not.toContain("schema_version");
  });

  it("never returns a kind=block JSON dump for a plain object", () => {
    // Specifically the shape that previously hit the JSON-fallback path.
    const obj = { id: "x", name: "Foo", description: "bar baz" };
    const preview = extractResultPreview(obj);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).not.toContain("{");
  });

  // -------------------------------------------------------------------
  // MCP error envelopes
  // -------------------------------------------------------------------

  it("summarizes Zod input-validation errors from MCP transport", () => {
    const text =
      'MCP error -32602: Input validation error: Invalid arguments for tool libi.x: ' +
      JSON.stringify([
        {
          code: "invalid_type",
          path: ["count"],
          message: "Expected number, received string",
        },
      ]);
    const preview = extractResultPreview(text);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toContain("count");
    expect(preview?.text).toContain("Expected number");
    expect(preview?.text).not.toContain("{");
  });

  it("summarizes Zod errors arriving via the MCP content-array shape", () => {
    const result = [
      {
        type: "text",
        text:
          "MCP error -32602: Input validation error: Invalid arguments for tool libi.analysis_describe_frame: " +
          JSON.stringify([
            {
              code: "invalid_type",
              path: ["description"],
              message: "Expected object, received string",
            },
            {
              code: "invalid_type",
              path: ["other"],
              message: "Required",
            },
          ]),
      },
    ];
    const preview = extractResultPreview(result);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toContain("description");
    expect(preview?.text).toContain("Expected object");
    // "+1 more" badge for the second error.
    expect(preview?.text).toMatch(/\+1 more/);
  });

  it("falls back to plain message when MCP error carries no Zod array", () => {
    const text = "MCP error -32603: Internal server error: something went wrong";
    const preview = extractResultPreview(text);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toContain("Internal server error");
    expect(preview?.text).not.toContain("MCP error");
  });

  // -------------------------------------------------------------------
  // Top-level JSON-string MCP results (e.g. ElevenLabs speech_to_text)
  // -------------------------------------------------------------------

  it("parses JSON-stringified result + peels {result:…} wrapper for MCP tools", () => {
    // ElevenLabs speech_to_text returns a top-level string that's JSON-
    // encoded `{"result":{"type":"text","text":"…transcript…"}}`. Before
    // the fix this hit the long-string branch and rendered as a raw
    // multi-line block. We expect a clean summary with the transcript
    // text directly (no `result:` prefix, no surrounding JSON braces).
    const transcript =
      "I'm just finishing work. I've got ten minutes before I need to leave because I'm meeting my friends for dinner.";
    const text = JSON.stringify({ result: { type: "text", text: transcript } });
    const preview = extractResultPreview(text);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toContain("just finishing work");
    expect(preview?.text).not.toContain("{");
    expect(preview?.text).not.toContain("\"result\"");
  });

  it("peels nested {result: {type, text}} wrappers from top-level objects too", () => {
    // The same shape but as a parsed object rather than a JSON string.
    const result = { result: { type: "text", text: "transcript content" } };
    const preview = extractResultPreview(result);
    expect(preview?.kind).toBe("summary");
    expect(preview?.text).toBe("transcript content");
  });
});

describe("formatSubagentResult", () => {
  it("strips the [{type:'text',text:…}] MCP wrapper", () => {
    const raw = JSON.stringify([
      { type: "text", text: "hello world" },
    ]);
    expect(formatSubagentResult(raw)).toBe("hello world");
  });

  it("pretty-prints structured JSON inside the wrapped text block", () => {
    const inner = JSON.stringify([
      { schema_version: "frame_v1", frame_index: 1, scene: "A blonde woman" },
    ]);
    const raw = JSON.stringify([{ type: "text", text: inner }]);
    const out = formatSubagentResult(raw);
    expect(out).toContain('"schema_version": "frame_v1"');
    expect(out).toContain('"frame_index": 1');
    expect(out.split("\n").length).toBeGreaterThan(3); // multi-line indented
  });

  it("joins multiple text blocks", () => {
    const raw = JSON.stringify([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
    expect(formatSubagentResult(raw)).toBe("one\ntwo");
  });

  it("returns the input untouched for plain non-JSON text", () => {
    expect(formatSubagentResult("just a reply")).toBe("just a reply");
  });

  it("pretty-prints a top-level JSON object", () => {
    const raw = JSON.stringify({ status: "completed", count: 3 });
    const out = formatSubagentResult(raw);
    expect(out).toContain('"status": "completed"');
    expect(out).toContain('"count": 3');
  });

  it("pretty-prints leading JSON and keeps trailing prose (frame_v1 + ARTIFACT_MAPPING + OVERALL_STYLE)", () => {
    // The actual Task output shape from session 108d13a5: a frame_v1
    // JSON array followed by ARTIFACT_MAPPING / OVERALL_STYLE blocks.
    // Pure JSON.parse fails on the whole thing; we should still
    // pretty-print the array and preserve the trailing notes.
    const inner =
      JSON.stringify([
        { schema_version: "frame_v1", frame_index: 1, scene: "intro" },
      ]) +
      "\n\nARTIFACT_MAPPING:\n1: abc-123\n\nOVERALL_STYLE: short prose summary";
    const raw = JSON.stringify([{ type: "text", text: inner }]);
    const out = formatSubagentResult(raw);
    expect(out).toContain('"schema_version": "frame_v1"');
    expect(out).toContain("ARTIFACT_MAPPING");
    expect(out).toContain("OVERALL_STYLE");
    // Prose appears AFTER the indented JSON.
    const jsonEnd = out.indexOf("]");
    const promptIdx = out.indexOf("ARTIFACT_MAPPING");
    expect(promptIdx).toBeGreaterThan(jsonEnd);
  });
});
