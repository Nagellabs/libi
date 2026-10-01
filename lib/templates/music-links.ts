import { songLabel } from "@/lib/audio-rights/types";
import type { TemplateMusicLink } from "@/lib/templates/scaffold-schema";

/** "Title — Artist" per music link: what a template names but does not carry. */
export function musicNotIncluded(scaffold: { musicLinks?: ReadonlyArray<TemplateMusicLink> }): string[] {
  return (scaffold.musicLinks ?? []).map((m) => songLabel(m.track));
}
