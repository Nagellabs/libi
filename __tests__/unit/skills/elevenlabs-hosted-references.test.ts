// ElevenLabs is its hosted server since 2026-09-25 (lib/providers/catalog.ts): every creative tool is a flow run
// whose `generations_count` defaults to 4. These pin the rules that cost a user money or lose their result when an
// agent gets them wrong, in the one reference that owns the call mechanics, and keep the old local server's tool
// names to their one-line fallback in every ElevenLabs reference.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const skillsDir = path.resolve(__dirname, "../../../mcp/skills");
const read = (rel: string) => readFileSync(path.join(skillsDir, rel), "utf8");
const OWNER = "ai-asset-generation/references/providers/elevenlabs.md";
/** The local server's tools (`uvx elevenlabs-mcp`), which the hosted server does not have. */
const OLD_TOOLS = /\b(text_to_speech|compose_music|text_to_sound_effects|speech_to_speech|speech_to_text|isolate_audio|voice_clone)\b/;

const elevenlabsRefs = readdirSync(skillsDir)
  .map((skill) => path.join(skill, "references", "providers", "elevenlabs.md"))
  .filter((rel) => existsSync(path.join(skillsDir, rel)));

describe("ElevenLabs hosted — the call mechanics", () => {
  const ref = read(OWNER);

  it("ai-asset-generation owns them, and every other ElevenLabs reference points there", () => {
    expect(ref).toMatch(/^# elevenlabs — provider reference for `ai-asset-generation`/m);
    for (const rel of elevenlabsRefs.filter((r) => r !== OWNER && !r.startsWith("music-video-creation"))) {
      expect(read(rel), rel).toContain("`ai-asset-generation`'s `references/providers/elevenlabs.md`");
    }
  });

  it("one generation per call, priced with estimate_only and confirmed before it runs", () => {
    expect(ref).toMatch(/\*\*Always pass `generations_count: 1`\.\*\* The default is 4/);
    expect(ref).toMatch(/`estimate_only: true`/);
    expect(ref).toMatch(/wait for a yes/);
  });

  it("a required context, voices from the list, and never the agents_* tools", () => {
    expect(ref).toMatch(/required \*\*`context`\*\*/);
    expect(ref).toMatch(/`creative_list_voices`/);
    expect(ref).toMatch(/Never invent a `voice_id`/);
    expect(ref).toMatch(/Never call its `agents_\*` tools/);
  });

  it("polls with poll_after_seconds and downloads the short-lived output URL at once, through Step 9's import", () => {
    expect(ref).toMatch(/`creative_get_flow_run_status/);
    expect(ref).toMatch(/`poll_after_seconds` with `libi\.sleep`/);
    expect(ref).toMatch(/\*\*The URL is short-lived: download it right away\*\*/);
    expect(ref).toMatch(/SKILL\.md Step 9/);
    expect(ref).toMatch(/`libi\.upload_file`/);
  });

  // The live result (2026-09-25): the audio URL is in `media[]`, joined by `generation_id` — the generation itself
  // has none — a transcript is flat text in `transcripts[]`, and credits can be fractional.
  it("names where the live result really puts the audio and the text", () => {
    expect(ref).toMatch(/the audio\s+is in `media\[\]`: each entry's `url` \(an mp3\), matched to its generation by `generation_id`/);
    expect(ref).toMatch(/`generations\[\]` carry the status and `price\.credits`, never a URL/);
    expect(ref).toMatch(/`transcripts\[\]` instead: `text` is flat text only, with no per-word timing and no speaker\s+labels/);
    expect(ref).toMatch(/`estimate\.credits`[\s\S]{0,120}can be fractional/);
    expect(ref).toMatch(/under its `labels`/);
    // The fake's old invented fields are named nowhere in any ElevenLabs reference.
    for (const rel of elevenlabsRefs) {
      expect(read(rel), rel).not.toMatch(/output_url|estimated_credits|canvas_url/);
    }
  });

  it("a local file goes up through the upload URL with the exact Content-Type, then onto the flow", () => {
    expect(ref).toMatch(/`creative_create_asset_upload/);
    expect(ref).toMatch(/`Content-Type` exactly\s+`mime_type`/);
    expect(ref).toMatch(/`creative_finalize_asset_upload\(\{ asset_id, flow_id, context \}\)`/);
  });
});

describe("ElevenLabs hosted — the old local server's tools", () => {
  it("every ElevenLabs reference names them only in its one fallback paragraph", () => {
    expect(elevenlabsRefs.length).toBeGreaterThanOrEqual(5);
    for (const rel of elevenlabsRefs) {
      const paragraphs = read(rel).split(/\n\s*\n/);
      const naming = paragraphs.filter((p) => OLD_TOOLS.test(p));
      for (const p of naming) expect(p, rel).toMatch(/older local server/);
      expect(naming.length, rel).toBeLessThanOrEqual(1);
    }
  });
});

describe("ElevenLabs hosted — review fixes (2026-09-25)", () => {
  it("voice-replacement's voice changer call carries generations_count: 1, and ElevenLabs transcription is never a Whisper stand-in", () => {
    const ref = read("voice-replacement/references/providers/elevenlabs.md");
    const changer = ref.split(/\n\s*\n/).find((p) => p.includes('"voice-changer"'))!;
    expect(changer).toMatch(/`generations_count: 1`/);
    expect(ref).toMatch(/only on that skill's paid path, when the user\s+asked for it — never because Whisper isn't installed yet/);
  });

  it("ai-asset-generation's no-upload rule has exactly one carve-out: a presigned URL the provider's OWN tool handed over", () => {
    const body = read("ai-asset-generation/SKILL.md");
    // The fal rule is intact.
    expect(body).toMatch(/\*\*NEVER do the upload yourself\.\*\* Do NOT read `FAL_KEY`/);
    expect(body).toMatch(/do NOT request a signed upload URL or `PUT`\/`curl` bytes to provider storage/);
    // The carve-out, as an option and as the exception.
    expect(body).toMatch(/if the provider's own MCP tool hands you a presigned upload URL \(ElevenLabs' `creative_create_asset_upload`\), PUT the file there/);
    expect(body).toMatch(/\*\*The one exception:\*\* when the provider's OWN MCP tool hands you a presigned upload URL[\s\S]{0,200}no key, no `Authorization` header\. Never ask for such a URL any other way, and never for fal\./);
  });
});
