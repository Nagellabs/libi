import type { SketchSlot } from "./types";

export const STORYBOARD_DIR = "storyboard";
export const STORYBOARD_MANIFEST = `${STORYBOARD_DIR}/manifest.json`;

export function cardDir(cardId: string): string { return `${STORYBOARD_DIR}/cards/${cardId}`; }
export function cardJsonPath(cardId: string): string { return `${cardDir(cardId)}/card.json`; }
export function cardRenderPath(cardId: string, file: string): string { return `${cardDir(cardId)}/${file}`; }
export function cardSketchesDir(cardId: string): string {
  return `${cardDir(cardId)}/sketches`;
}
export function slotSketchPath(cardId: string, slotId: string): string {
  return `${cardSketchesDir(cardId)}/${slotId}.png`;
}
export function slotUnitPath(cardId: string, slot: SketchSlot): string {
  return `${cardDir(cardId)}/${slot.render?.file ?? `sketches/${slot.id}/unit.jsx`}`;
}
