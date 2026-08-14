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
  return [
    "ctx.save();",
    "ctx.globalAlpha = 0.85;",
    "ctx.fillStyle = '#66ccff';",
    "ctx.fillRect(0, 0, width, height);",
    "ctx.restore();",
  ].join("\n");
}
