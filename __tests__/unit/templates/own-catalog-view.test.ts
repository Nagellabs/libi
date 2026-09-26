// __tests__/unit/templates/own-catalog-view.test.ts
//
// A-F live check N1 (2026-09-26): right after the user's own publish the Public tab said "No public
// templates yet". The tab now shows the user's own just-published template from /mine until the
// catalog copy lists it, and drops a card the user just hid.
import { describe, expect, it } from "vitest";
import type { MineTemplate } from "@/lib/templates/cloud/client";
import { ownCatalogView } from "@/lib/templates/own-catalog-view";
import type { OwnCatalogChangeDto, TemplateSummary } from "@/lib/templates/types";

const A = "a".repeat(20);
const B = "b".repeat(20);
const change = (cloudId: string, kind: OwnCatalogChangeDto["kind"], version = 1): OwnCatalogChangeDto => ({ cloudId, kind, version, at: "2026-09-26T00:00:00.000Z" });
const mine = (id: string, over: Partial<MineTemplate> = {}): MineTemplate =>
  ({ id, name: `Mine ${id[0]}`, version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: "x", updatedAt: "x", ...over }) as MineTemplate;
const local = (cloudId: string, over: Partial<TemplateSummary> = {}) => ({ id: `local-${cloudId[0]}`, cloudId, name: `Local ${cloudId[0]}`, origin: "local", ...over }) as TemplateSummary;
const none = new Set<string>();

describe("ownCatalogView", () => {
  it("a publish the copy doesn't list yet is shown from /mine, with the local template it came from", () => {
    const v = ownCatalogView({ changes: [change(A, "published")], listedIds: none, mine: { templates: [mine(A)] }, local: [local(A), local(B)] });
    expect(v.justListed).toEqual([{ cloudId: A, kind: "published", name: "Mine a", local: local(A) }]);
    expect([...v.hiddenIds]).toEqual([]);
  });

  it("once the copy lists it, it is an ordinary card and nothing more", () => {
    expect(ownCatalogView({ changes: [change(A, "published")], listedIds: new Set([A]), mine: { templates: [mine(A)] }, local: [] }).justListed).toEqual([]);
  });

  it("with /mine not read yet, or unreadable, the local copy's name stands in; with neither, nothing is shown", () => {
    expect(ownCatalogView({ changes: [change(A, "shown")], listedIds: none, mine: undefined, local: [local(A)] }).justListed).toMatchObject([{ name: "Local a", kind: "shown" }]);
    expect(ownCatalogView({ changes: [change(A, "shown")], listedIds: none, mine: { templates: [mine(A)], error: "unreachable" }, local: [local(A)] }).justListed).toMatchObject([{ name: "Local a" }]);
    expect(ownCatalogView({ changes: [change(A, "published")], listedIds: none, mine: { templates: [] }, local: [] }).justListed).toEqual([]);
  });

  it("an installed copy of someone else's template with the same id is never taken for the user's own", () => {
    const v = ownCatalogView({ changes: [change(A, "published")], listedIds: none, mine: undefined, local: [local(A, { origin: "installed" })] });
    expect(v.justListed).toEqual([]);
  });

  it("a hide made here leaves the card out although the copy still lists it", () => {
    const v = ownCatalogView({ changes: [change(A, "hidden")], listedIds: new Set([A]), mine: { templates: [mine(A)] }, local: [] });
    expect([...v.hiddenIds]).toEqual([A]);
    expect(v.justListed).toEqual([]);
  });

  it("/mine's hidden or taken-down templates are left out too — but a change made here decides for its own template", () => {
    const v = ownCatalogView({
      changes: [change(B, "shown")],
      listedIds: new Set([A]),
      // /mine read before the show: still says hidden.
      mine: { templates: [mine(A, { hidden: true, moderated: true }), mine(B, { hidden: true })] },
      local: [],
    });
    expect([...v.hiddenIds]).toEqual([A]);
    expect(v.justListed).toMatchObject([{ cloudId: B, kind: "shown", name: "Mine b" }]);
    // An unreadable /mine hides nothing.
    expect([...ownCatalogView({ changes: [], listedIds: new Set([A]), mine: { templates: [mine(A, { hidden: true })], error: "unreachable" }, local: [] }).hiddenIds]).toEqual([]);
  });
});
