import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function load() { return import("@/mcp/dev/fake-elevenlabs/tools"); }
function readCalls(home: string) {
  const p = join(home, "test-mode", "elevenlabs-calls.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("fake-elevenlabs tools", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libi-el-tools-")); process.env.LIBI_HOME = home; });
  afterEach(() => { delete process.env.LIBI_HOME; rmSync(home, { recursive: true, force: true }); });

  it("text_to_speech returns faithful prose + records effective model_id", async () => {
    const t = await load();
    const res = await t.text_to_speech({ text: "Hello there", voice_id: "v123" });
    const text = res.content[0].text;
    expect(text).toMatch(/^Success\. File saved as: .+\.wav\. Voice used: v123$/);
    const path = text.split("File saved as: ")[1].split(". Voice used")[0];
    expect(existsSync(path)).toBe(true);
    const call = readCalls(home).at(-1);
    expect(call.tool).toBe("text_to_speech");
    expect(call.voice_id).toBe("v123");
    expect(call.model_id).toBe("eleven_multilingual_v2"); // effective default
  });

  it("text_to_speech with no voice uses DEFAULT_VOICE_ID", async () => {
    const t = await load();
    const res = await t.text_to_speech({ text: "Hi" });
    expect(res.content[0].text).toMatch(/Voice used: cgSgspJ2msm6clMCkdW9$/);
  });

  it("text_to_speech errors on empty text and on dual voice args", async () => {
    const t = await load();
    expect((await t.text_to_speech({ text: "" })).error).toBe("Text is required.");
    const dual = await t.text_to_speech({ text: "x", voice_id: "a", voice_name: "b" });
    expect(dual.error).toBe("voice_id and voice_name cannot both be provided.");
  });

  it("text_to_sound_effects returns default success message; validates duration", async () => {
    const t = await load();
    const ok = await t.text_to_sound_effects({ text: "whoosh", duration_seconds: 2 });
    expect(ok.content[0].text).toMatch(/^Success\. File saved as: .+\.wav$/);
    expect((await t.text_to_sound_effects({ text: "x", duration_seconds: 9 })).error)
      .toBe("Duration must be between 0.5 and 5 seconds");
  });

  it("compose_music requires exactly one of prompt/plan", async () => {
    const t = await load();
    const ok = await t.compose_music({ prompt: "lofi", music_length_ms: 8000 });
    expect(ok.content[0].text).toMatch(/^Success\. File saved as: .+\.wav$/);
    expect((await t.compose_music({})).error)
      .toBe("Either prompt or composition_plan must be provided. Prompt: None");
  });

  it("isolate_audio reads input, errors on missing file", async () => {
    const t = await load();
    const input = join(home, "in.wav");
    writeFileSync(input, "RIFFxxxx");
    const ok = await t.isolate_audio({ input_file_path: input });
    expect(ok.content[0].text).toMatch(/^Success\. File saved as: .+\.wav$/);
    const miss = await t.isolate_audio({ input_file_path: join(home, "nope.wav") });
    expect(miss.error).toBe(`File (${join(home, "nope.wav")}) does not exist`);
  });

  it("voice_clone returns deterministic id + faithful prose", async () => {
    const t = await load();
    const a = await t.voice_clone({ name: "Ava", files: [] });
    const b = await t.voice_clone({ name: "Ava", files: [] });
    const idA = a.content[0].text.match(/ID: (\S+)/)![1];
    const idB = b.content[0].text.match(/ID: (\S+)/)![1];
    expect(idA).toBe(idB);
    expect(a.content[0].text).toMatch(/^Voice cloned successfully: Name: Ava/);
    expect(readCalls(home).at(-1).voice_id).toBe(idA);
  });

  it("speech_to_text returns transcript directly when asked", async () => {
    const t = await load();
    const input = join(home, "clip.wav");
    writeFileSync(input, "RIFFxxxx");
    const res = await t.speech_to_text({ input_file_path: input, return_transcript_to_client_directly: true });
    expect(res.content[0].text).toContain("[fake-elevenlabs]");
    const saved = await t.speech_to_text({ input_file_path: input });
    expect(saved.content[0].text).toBe(`Transcription saved to ${input}`);
  });
});
