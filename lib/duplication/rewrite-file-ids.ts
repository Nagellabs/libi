/**
 * Deep-clone `node` and replace every `fileId` string value that appears in
 * `idMap` with its mapped value. Schema-agnostic: handles video scenes,
 * audio clips, image/video overlays, and tracked-overlay image/video content
 * without enumerating manifest types. `trackId` is intentionally NOT rewritten
 * (tracks are not copied by cB — see the design spec). The input is not mutated.
 */
export function rewriteFileIds(node: unknown, idMap: Map<string, string>): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => rewriteFileIds(child, idMap));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "fileId" && typeof value === "string" && idMap.has(value)) {
        out[key] = idMap.get(value)!;
      } else {
        out[key] = rewriteFileIds(value, idMap);
      }
    }
    return out;
  }
  return node;
}
