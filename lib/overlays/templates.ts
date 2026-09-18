/** Starter body written when add_overlay omits `body`, so the preview is never blank. */
export function starterBody(kind: "code" | "three" | "tracked-code"): string {
  if (kind === "three") {
    // Minimal vetted three scene: a billboard plane the agent then refines.
    return [
      "const geo = new THREE.PlaneGeometry(2, 0.6);",
      "const mat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.9 });",
      "const mesh = new THREE.Mesh(geo, mat);",
      "scene.add(mesh);",
    ].join("\n");
  }
  // canvas (code + tracked-code): fill a translucent panel so the rect is visible.
  // createDrawFunction only injects a single `context` param (plus the helper
  // names) — `ctx`/`width`/`height` are NOT free identifiers in scope, they
  // must be destructured off `context` first, exactly like every skill
  // template does. Omitting this throws "ctx is not defined" at draw time
  // (QA 2026-09-18 B1): the body is syntactically valid so validateDrawFunction
  // passes, but every real invocation (plain `code` overlay AND `tracked`
  // overlay with content.kind "code" — both share this same DrawContext
  // shape, see lib/engine/overlay-renderer.ts) throws.
  return [
    "const { ctx, width, height } = context;",
    "ctx.save();",
    "ctx.globalAlpha = 0.85;",
    "ctx.fillStyle = '#66ccff';",
    "ctx.fillRect(0, 0, width, height);",
    "ctx.restore();",
  ].join("\n");
}
