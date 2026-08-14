/**
 * Pure scaffolds for the ask-agent composer. The user edits the returned text
 * before sending; these just seed it with the right context so the agent acts
 * on the correct overlay / kind.
 */
const KIND_LABEL: Record<string, string> = { code: "code", three: "3D", tracked: "tracked" };

export function buildCreatePrompt(
  kind: "code" | "three" | "tracked",
  description: string,
  ctx: { startTime: number; timecode?: string },
): string {
  const label = KIND_LABEL[kind] ?? kind;
  // Quote the playhead's exact instant. When the caller passes the timeline
  // timecode (HH:MM:SS:FF) we lead with it so the prompt matches the selector the
  // user is looking at, then give the precise seconds the agent uses verbatim.
  const at = ctx.timecode
    ? `${ctx.timecode} (${ctx.startTime.toFixed(2)}s)`
    : `${ctx.startTime.toFixed(2)}s`;
  return [
    `Create a ${label} overlay on the currently-open piece, starting at ${at}.`,
    description ? `What it should do: ${description}` : `Describe what it should do here.`,
    `Use the libi add_overlay tool (kind: "${kind}").`,
  ].join("\n");
}

export function buildModifyPrompt(
  overlay: { id: string; kind: string; content?: string },
  description: string,
): string {
  const what = overlay.content ? ` (current text: "${overlay.content}")` : "";
  return [
    `Modify the ${overlay.kind} overlay "${overlay.id}"${what} on the currently-open piece.`,
    description ? `Change: ${description}` : `Describe the change here.`,
    `Use the libi update_overlay tool — modify this overlay, do not create a new one.`,
  ].join("\n");
}

/** Seed prompt for transcribing a selected audio clip's source file. The user
 *  sends or copies it from the ask-agent composer; the agent runs the actual
 *  transcription (ElevenLabs / analysis tools) and reports the transcript back. */
export function buildTranscribePrompt(audio: {
  fileId: string;
  fileName: string;
  label?: string;
}): string {
  const name = audio.label ? `"${audio.label}" (${audio.fileName})` : `"${audio.fileName}"`;
  return [
    `Transcribe the audio ${name} on the currently-open piece (file id: ${audio.fileId}).`,
    `Produce a clean transcript of the speech, with timestamps if the tool provides them.`,
    `Use libi's transcription / analysis tools, then share the transcript back here.`,
  ].join("\n");
}
