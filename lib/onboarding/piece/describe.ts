/**
 * What `libi.build_onboarding_piece` just built, in prose, DERIVED FROM THE
 * DEFINITION.
 *
 * The tool used to answer with `{ pieceId, version, bytes, assets, reused }`
 * and nothing else, which left the agent describing the film from prose
 * hardcoded in the onboarding skill. That prose is a copy of facts that live
 * in `lib/onboarding/piece/v<n>/index.ts`, and a copy of a fact is a fact that
 * goes stale: recut the film for v2 and the skill keeps telling every new user
 * about the old one, with nothing failing. So the description is computed from
 * the same object the runner builds, and versions with it.
 *
 * WRITTEN FOR AN AGENT MID-TURN, not for a person browsing docs. It is read
 * once, relayed in the agent's own words, and then thrown away — so it is
 * compact, and it carries no id, no path, and no user text. Every number in it
 * is counted here rather than restated.
 */
import type { OnboardingPieceDefinition } from "./types";

/** Beat names are slate-style — "SLOT D — tracking + code overlay". The slate
 *  prefix is production shorthand; the half after it is what the beat actually
 *  is, and it is the half a first-run user should hear. */
function beatName(name: string): string {
  return name.replace(/^\s*SLOT\s+[A-Z]\s*[—–-]\s*/i, "").trim() || name;
}

/** Seconds, at the precision the film is actually cut to. */
function secs(n: number): string {
  return `${Math.round(n * 10) / 10}s`;
}

function countByKind(definition: OnboardingPieceDefinition): string {
  const counts = new Map<string, number>();
  for (const o of definition.overlays) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
}

export function describeOnboardingPiece(definition: OnboardingPieceDefinition): string {
  const endOf = (x: { startTime: number; duration: number }) => x.startTime + x.duration;
  // The same rule `getCompositionFrames` applies — restated as arithmetic
  // rather than imported, because this module is loaded by the MCP child and
  // the renderer is not something that child should ever pull in.
  const runtime = Math.max(
    ...definition.overlays.map(endOf),
    ...definition.audioClips.map(endOf),
  );
  const lastAudio = Math.max(0, ...definition.audioClips.map(endOf));

  // Music beds are the clips that ARE ducked; the voice-over is whatever they
  // duck against. Both fall out of the sidechain wiring, so neither is a
  // hand-kept list that can disagree with the film.
  const beds = definition.audioClips.filter((c) => c.duck);
  const voiceIds = new Set(beds.flatMap((c) => c.duck?.sidechainClipIds ?? []));
  const others = definition.audioClips.length - beds.length - voiceIds.size;
  const muted = definition.audioClips.filter((c) => c.enabled === false).length;

  const lines = [
    `${definition.name} — ${secs(runtime)}, ${definition.width}x${definition.height} @${definition.fps}fps.`,
    `Beats: ${definition.beats
      .map((b) => `${beatName(b.name)} (${secs(b.duration)})`)
      .join(" → ")}.`,
    `Layers: ${definition.overlays.length} overlays (${countByKind(definition)}), ` +
      `${definition.audioClips.length} audio clips.`,
    `Audio: ${voiceIds.size} voice-over lines with ${beds.length} music beds ` +
      `sidechain-ducked under them, plus ${others} SFX / clip-audio` +
      `${muted > 0 ? ` (${muted} muted)` : ""}.`,
  ];

  // Stated only when it is TRUE of the definition in hand. The demo ships no
  // object track — the reticle in the tracking beat is a baked animation, the
  // same kind of mock UI as slot A's chat window — and the agent must not
  // imply libi ran tracking on the user's machine to make it.
  if (!definition.overlays.some((o) => o.kind === "tracked")) {
    lines.push(
      "No live tracking ran: the reticle in the tracking beat is a pre-made animation " +
        "(built with libi's real object tracking, then baked in), like every other mock UI here.",
    );
  }
  if (runtime - lastAudio >= 1) {
    lines.push(
      `The last ${secs(runtime - lastAudio)} are a deliberate silent hold on the end card, not a stall.`,
    );
  }
  lines.push("Every layer is live and editable.");
  return lines.join("\n");
}
