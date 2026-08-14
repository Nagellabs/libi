/** Pure raw→raw normalization run BEFORE Zod parsing. A card persisted before
 *  sketch slots has a top-level `render` (+ optional `schematicFileId`) and no
 *  `sketches`. Lift those into a single `start` slot bound to `start_frame`, and
 *  strip the old keys. Idempotent: a card that already has `sketches` is returned
 *  unchanged. Operates on `unknown` JSON so it can run before parseCard. */
export function migrateRawCardSketches(input: unknown): Record<string, unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (Array.isArray(raw.sketches)) return raw;
  const { render, schematicFileId, ...rest } = raw;
  const slot: Record<string, unknown> = { id: "sk_1", role: "start", paramKey: "start_frame" };
  if (render && typeof render === "object") slot.render = render;
  return { ...rest, sketches: [slot] };
}
