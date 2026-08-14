import { describe, it, expect } from "vitest";
import { roadCaption, billboardCaption, simpleObject } from "@/lib/engine/three-templates";
import { validateThreeFunction, THREE_PARAM_NAMES } from "@/lib/ai/scene-validator";

// Shared stub helpers
function makeScene() {
  return { add() {} };
}
function makeCamera() {
  return { position: { set() {} }, lookAt() {}, updateProjectionMatrix() {} };
}

describe("three-templates: roadCaption", () => {
  it("returns a body that validates and compiles to a function returning an update fn", () => {
    const body = roadCaption({ text: "EH OH EH", color: "#ff3df2" });
    expect(validateThreeFunction(body)).toEqual({ valid: true });

    // Compile with stub injected params; invoke once → expect an update fn.
    // eslint-disable-next-line no-new-func
    const factory = new Function(...(THREE_PARAM_NAMES as unknown as string[]), body);
    class stubText {
      text = "";
      fontSize = 0;
      anchorX = "";
      anchorY = "";
      color = "";
      outlineColor = "";
      outlineBlur = 0;
      outlineWidth = 0;
      rotation = { x: 0 };
      position = { set(_x: number, _y: number, _z: number) {}, z: 0 };
      material = { transparent: false, opacity: 1 };
      sync() {}
    }
    const THREE = {
      AmbientLight: function () {},
    };
    const scene = { add() {} };
    const camera = { position: { set() {} }, lookAt() {}, updateProjectionMatrix() {} };
    const helpers = {
      interpolate: (p: number, _a: number[], b: number[]) => b[0] + (b[1] - b[0]) * p,
      easeOutCubic: (x: number) => x,
      easeInCubic: (x: number) => x,
    };
    const update = factory(THREE, scene, camera, {}, 1280, 720, stubText, helpers, {});
    expect(typeof update).toBe("function");
    expect(() => update({ progress: 0.5 })).not.toThrow();
  });
});

describe("three-templates: billboardCaption", () => {
  it("returns a body that validates and compiles to a function returning an update fn", () => {
    const body = billboardCaption({ text: "HELLO WORLD", color: "#ff3df2" });
    expect(validateThreeFunction(body)).toEqual({ valid: true });

    // eslint-disable-next-line no-new-func
    const factory = new Function(...(THREE_PARAM_NAMES as unknown as string[]), body);

    class stubText {
      text = "";
      fontSize = 0;
      anchorX = "";
      anchorY = "";
      color = "";
      outlineColor = "";
      outlineBlur = 0;
      outlineWidth = 0;
      position = { set(_x: number, _y: number, _z: number) {}, x: 0, y: 0 };
      scale = { set(_x: number, _y: number, _z: number) {} };
      material = { transparent: false, opacity: 1 };
      sync() {}
    }

    const THREE = {
      AmbientLight: function () {},
    };
    const helpers = {
      interpolate: (p: number, _a: number[], b: number[]) => b[0] + (b[1] - b[0]) * p,
      easeOutBack: (x: number) => x,
      easeInCubic: (x: number) => x,
      easeOutCubic: (x: number) => x,
    };

    const update = factory(THREE, makeScene(), makeCamera(), {}, 1280, 720, stubText, helpers, {});
    expect(typeof update).toBe("function");
    expect(() => update({ progress: 0.5, time: 1 })).not.toThrow();
  });
});

describe("three-templates: simpleObject", () => {
  it("returns a body that validates and compiles to a function returning an update fn", () => {
    const body = simpleObject({ color: "#19e3c2" });
    expect(validateThreeFunction(body)).toEqual({ valid: true });

    // eslint-disable-next-line no-new-func
    const factory = new Function(...(THREE_PARAM_NAMES as unknown as string[]), body);

    const stubMesh = {
      rotation: { x: 0, y: 0 },
      scale: { set(_x: number, _y: number, _z: number) {} },
    };

    const stubDir = {
      position: { set(_x: number, _y: number, _z: number) {} },
    };

    const THREE = {
      AmbientLight: function () {},
      DirectionalLight: function () { return stubDir; },
      TorusKnotGeometry: function () {},
      MeshStandardMaterial: function () {},
      Mesh: function () { return stubMesh; },
    };

    const helpers = {
      easeOutBack: (x: number) => x,
    };

    const update = factory(THREE, makeScene(), makeCamera(), {}, 1280, 720, function () {}, helpers, {});
    expect(typeof update).toBe("function");
    expect(() => update({ progress: 0.5, time: 1 })).not.toThrow();
  });
});
