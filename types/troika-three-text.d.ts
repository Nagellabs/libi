/** Minimal ambient declarations for troika-three-text (ships no .d.ts of its own).
 *  Covers only the surface used by lib/engine/three-overlay.ts: the `Text`
 *  Object3D subclass (with async `.sync()` SDF build) + `preloadFont`. */
declare module "troika-three-text" {
  import type { Object3D, Material } from "three";

  export class Text extends Object3D {
    text: string;
    color?: string | number;
    fontSize?: number;
    font?: string;
    anchorX?: number | string;
    anchorY?: number | string;
    outlineColor?: string | number;
    outlineWidth?: number | string;
    outlineBlur?: number | string;
    material: Material & { opacity: number; transparent: boolean };
    /** Rebuilds the SDF geometry/texture; invokes the callback when ready. */
    sync(callback?: () => void): void;
    /** Releases GPU resources held by this text instance. */
    dispose(): void;
  }

  export function preloadFont(
    options: { font?: string; characters?: string | string[] },
    callback: () => void,
  ): void;
}
