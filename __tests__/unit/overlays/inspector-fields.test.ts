import { describe, it, expect } from "vitest";

import {
  INSPECTOR_FIELDS,
  GROUP_ORDER,
  groupRank,
  groupForSection,
  findField,
  groupForField,
  isKnownFieldKey,
  targetGroupForField,
  fieldKeysForKind,
  fieldKeysForKindGroup,
  groupsForKind,
  defaultGroupForKind,
  hasGroupsForKind,
} from "@/lib/overlays/inspector-fields";

describe("inspector-fields registry (per-kind intent groups)", () => {
  describe("GROUP_ORDER / groupRank", () => {
    it("orders text < style < transform < 3d < anchors", () => {
      expect(GROUP_ORDER).toEqual(["text", "style", "transform", "3d", "anchors"]);
      expect(groupRank("text")).toBe(0);
      expect(groupRank("style")).toBe(1);
      expect(groupRank("transform")).toBe(2);
      expect(groupRank("3d")).toBe(3);
      expect(groupRank("anchors")).toBe(4);
    });
  });

  describe("groupForSection", () => {
    it("maps each known section to its intent group", () => {
      for (const s of ["position", "rotation", "transform", "camera"]) {
        expect(groupForSection(s)).toBe("transform");
      }
      for (const s of ["style", "background", "stroke", "shadow", "reveal"]) {
        expect(groupForSection(s)).toBe("style");
      }
      for (const s of ["content", "font"]) {
        expect(groupForSection(s)).toBe("text");
      }
      // The 3D extrusion section maps to the 3d group.
      expect(groupForSection("three-d")).toBe("3d");
      // The tracked manual re-anchor section maps to the anchors group.
      expect(groupForSection("anchors")).toBe("anchors");
    });
  });

  describe("groupForField (the headline contract)", () => {
    it("fontSize is in the transform group for text", () => {
      // Caption Size lives ONLY on the Transform tab now (font size IS the
      // caption's size); its registry home is the transform group.
      expect(groupForField("fontSize", "text")).toBe("transform");
    });
    it("content is in the text group for text", () => {
      expect(groupForField("content", "text")).toBe("text");
    });
    it("a placement field is in the transform group", () => {
      expect(groupForField("transformPosX", "text")).toBe("transform");
      expect(groupForField("opacity", "text")).toBe("transform");
    });
    it("returns undefined for a key not applicable to the kind", () => {
      expect(groupForField("content", "image")).toBeUndefined();
      expect(groupForField("camera", "text")).toBeUndefined();
    });
  });

  describe("groupsForKind", () => {
    it("text has all four groups in canonical order", () => {
      expect(groupsForKind("text")).toEqual(["text", "style", "transform", "3d"]);
    });
    it("image/video/code have Transform + 3D (the universal-3D gate)", () => {
      for (const kind of ["image", "video", "code"] as const) {
        expect(groupsForKind(kind)).toEqual(["transform", "3d"]);
      }
    });
    it("three has Transform (2D rect) + 3D (scene transform)", () => {
      expect(groupsForKind("three")).toEqual(["transform", "3d"]);
    });
    it("tracked has Transform + Anchors (manual re-anchor management tab)", () => {
      expect(groupsForKind("tracked")).toEqual(["transform", "anchors"]);
    });
  });

  describe("hasGroupsForKind", () => {
    it("text + the universal-3D kinds + three have a tab selector", () => {
      for (const kind of ["text", "image", "video", "code", "three"] as const) {
        expect(hasGroupsForKind(kind)).toBe(true);
      }
    });
    it("tracked has two groups (Transform | Anchors tab selector)", () => {
      expect(hasGroupsForKind("tracked")).toBe(true);
    });
  });

  describe("defaultGroupForKind", () => {
    it("is text for text (the first tab) and transform for the rest", () => {
      expect(defaultGroupForKind("text")).toBe("text");
      for (const kind of ["image", "video", "code", "three", "tracked"] as const) {
        expect(defaultGroupForKind(kind)).toBe("transform");
      }
    });
  });

  describe("targetGroupForField (per-kind)", () => {
    it("returns the field's group for the kind", () => {
      expect(targetGroupForField("background.color", "text")).toBe("style");
      expect(targetGroupForField("content", "text")).toBe("text");
      expect(targetGroupForField("transformPosX", "text")).toBe("transform");
      expect(targetGroupForField("transformPosX", "video")).toBe("transform");
    });
    it("returns undefined for a non-applicable (key,kind)", () => {
      expect(targetGroupForField("content", "image")).toBeUndefined();
      expect(targetGroupForField("nope", "text")).toBeUndefined();
    });
  });

  describe("findField (per-kind)", () => {
    it("returns background.color for text in the style group", () => {
      const def = findField("background.color", "text");
      expect(def).toBeDefined();
      expect(def?.kind).toBe("text");
      expect(def?.group).toBe("style");
    });
    it("returns undefined for an unknown key", () => {
      expect(findField("nope.not.a.field", "text")).toBeUndefined();
    });
    it("returns undefined for a known key on a non-applicable kind", () => {
      expect(findField("content", "image")).toBeUndefined();
    });
  });

  describe("isKnownFieldKey", () => {
    it("is true for a key that appears for any kind", () => {
      expect(isKnownFieldKey("content")).toBe(true);
      expect(isKnownFieldKey("transform3d.pose")).toBe(true);
      expect(isKnownFieldKey("background.color")).toBe(true);
      expect(isKnownFieldKey("transformPosX")).toBe(true);
    });
    it("is false for an unknown key", () => {
      expect(isKnownFieldKey("nope")).toBe(false);
    });
  });

  describe("fieldKeysForKindGroup", () => {
    it("text transform is the in-plane placement panel + rotate + opacity/z/timing", () => {
      // The out-of-plane keys (transformAngle/Elevation/PosZ) live in the 3d
      // group; the in-plane X/Y + rotate stay here. Text uses `rotation` as its
      // single in-plane spin control — it deliberately does NOT register the
      // generic `transformSpin` (that would be a duplicate). There is NO
      // `transformSize` (uniform scale) for text — `fontSize` is the single
      // caption size control.
      expect(new Set(fieldKeysForKindGroup("text", "transform"))).toEqual(
        new Set([
          "rotation",
          "opacity",
          "zOrder",
          "startTime",
          "endTime",
          "transformPosX",
          "transformPosY",
          // Size (fontSize) is the caption's single size control — homed here.
          "fontSize",
        ]),
      );
    });
    it("text text is content + typography", () => {
      expect(new Set(fieldKeysForKindGroup("text", "text"))).toEqual(
        new Set(["content", "fontFamily", "fontWeight", "align"]),
      );
    });
    it("text style is preset/color/background/stroke/shadow (reveal moved to the Effects panel)", () => {
      expect(new Set(fieldKeysForKindGroup("text", "style"))).toEqual(
        new Set([
          "style",
          "color",
          "background",
          "background.color",
          "background.padding",
          "background.radius",
          "stroke",
          "shadow",
        ]),
      );
    });
    it("text 3d is the place3d gate + extrusion fields + the spatial keys (Angle/Elevation/Depth, no spin, no Scale)", () => {
      expect(new Set(fieldKeysForKindGroup("text", "3d"))).toEqual(
        new Set([
          "place3d",
          "text3dEnabled",
          "text3dDepth",
          "text3dBevel",
          "text3dFrontColor",
          "text3dSideColor",
          "text3dLighting",
          "transform.reset",
          "transform3d.pose",
          "transform3d.rotation",
          "transformPosZ",
        ]),
      );
    });
    it("image transform is opacity/z/timing + the PLANAR placement panel (no spatial keys)", () => {
      expect(new Set(fieldKeysForKindGroup("image", "transform"))).toEqual(
        new Set([
          "opacity",
          "zOrder",
          "startTime",
          "endTime",
          "transformPosX",
          "transformPosY",
          "transformSpin",
          "transformSize",
        ]),
      );
    });
    it("image 3d is the place3d gate + the spatial-orientation keys (no Scale)", () => {
      expect(new Set(fieldKeysForKindGroup("image", "3d"))).toEqual(
        new Set(["place3d", "transform3d.pose", "transform3d.rotation", "transformPosZ"]),
      );
    });
    it("video transform is opacity + the PLANAR placement panel; 3d is the gate + spatial keys (no Scale)", () => {
      expect(new Set(fieldKeysForKindGroup("video", "transform"))).toEqual(
        new Set(["opacity", "transformPosX", "transformPosY", "transformSpin", "transformSize"]),
      );
      expect(new Set(fieldKeysForKindGroup("video", "3d"))).toEqual(
        new Set(["place3d", "transform3d.pose", "transform3d.rotation", "transformPosZ"]),
      );
    });
    it("code 3d is the place3d gate + the spatial-orientation keys (no Scale)", () => {
      expect(new Set(fieldKeysForKindGroup("code", "3d"))).toEqual(
        new Set(["place3d", "transform3d.pose", "transform3d.rotation", "transformPosZ"]),
      );
    });
    it("non-text kinds have no style/text group keys", () => {
      for (const kind of ["image", "video", "code", "tracked", "three"] as const) {
        expect(fieldKeysForKindGroup(kind, "style")).toEqual([]);
        expect(fieldKeysForKindGroup(kind, "text")).toEqual([]);
      }
    });
    it("three transform is the 2D rect/size/opacity (scene transform moved to 3d)", () => {
      // three's Size control is the generic rect `size` field (the SizeField),
      // identical to image/video/code — rect resizing scales the apparent content.
      expect(new Set(fieldKeysForKindGroup("three", "transform"))).toEqual(
        new Set([
          "opacity",
          "rotation",
          "position",
          "size",
          "zOrder",
          "flipH",
          "flipV",
          "startTime",
          "endTime",
        ]),
      );
    });
    it("three 3d is the camera/reset/scene-transform gizmo keys (no Scale)", () => {
      // Unified spatial vocabulary: rotation (Angle/Elevation/Spin), Depth
      // (position.z) — plus camera + reset. Scale was removed.
      expect(new Set(fieldKeysForKindGroup("three", "3d"))).toEqual(
        new Set([
          "transform3d.pose",
          "transform.reset",
          "transform3d.rotation",
          "transform3d.position",
        ]),
      );
    });
  });

  describe("fieldKeysForKind union", () => {
    it("equals the union of all groups' keys for the kind", () => {
      for (const kind of ["text", "image", "video", "code", "three", "tracked"] as const) {
        const union = new Set(
          groupsForKind(kind).flatMap((g) => fieldKeysForKindGroup(kind, g)),
        );
        expect(new Set(fieldKeysForKind(kind))).toEqual(union);
      }
    });
  });

  describe("INSPECTOR_FIELDS integrity", () => {
    it("has one entry per (key, kind) pair (no duplicates)", () => {
      const seen = new Set<string>();
      for (const f of INSPECTOR_FIELDS) {
        const id = `${f.kind}:${f.key}`;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    });

    it("never places a key in two groups for the same kind", () => {
      const groupByKindKey = new Map<string, string>();
      for (const f of INSPECTOR_FIELDS) {
        const id = `${f.kind}:${f.key}`;
        if (groupByKindKey.has(id)) {
          expect(groupByKindKey.get(id)).toBe(f.group);
        } else {
          groupByKindKey.set(id, f.group);
        }
      }
    });

    it("every entry has a single kind + a label + a section + a group", () => {
      for (const f of INSPECTOR_FIELDS) {
        expect(typeof f.kind).toBe("string");
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.section.length).toBeGreaterThan(0);
        expect(GROUP_ORDER).toContain(f.group);
      }
    });
  });
});
