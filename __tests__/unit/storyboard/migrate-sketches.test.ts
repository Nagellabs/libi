import { describe, it, expect } from "vitest";
import { migrateRawCardSketches } from "@/lib/storyboard/migrate-sketches";

describe("migrateRawCardSketches", () => {
  it("lifts legacy render + schematicFileId into a start slot", () => {
    const out = migrateRawCardSketches({
      id: "c1",
      render: { kind: "satori", file: "render.jsx" },
      schematicFileId: "file_sch",
    });
    expect(out.sketches).toEqual([
      { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "render.jsx" } },
    ]);
    expect(out.render).toBeUndefined();
    expect(out.schematicFileId).toBeUndefined();
  });

  it("is idempotent — a card that already has sketches passes through unchanged", () => {
    const card = { id: "c1", sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame" }] };
    expect(migrateRawCardSketches(card)).toEqual(card);
  });

  it("synthesizes a start slot for a legacy card with no render at all", () => {
    const out = migrateRawCardSketches({ id: "c1" });
    expect(out.sketches).toEqual([{ id: "sk_1", role: "start", paramKey: "start_frame" }]);
  });
});
