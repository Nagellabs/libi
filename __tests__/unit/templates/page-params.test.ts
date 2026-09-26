import { describe, it, expect } from "vitest";
import { parseTemplatesPageParams } from "@/components/templates/templates-page/use-templates-page-params";

describe("parseTemplatesPageParams", () => {
  it("defaults to mine and reads template", () => {
    expect(parseTemplatesPageParams(new URLSearchParams(""))).toEqual({ tab: "mine", template: null, review: null, view: null });
    expect(parseTemplatesPageParams(new URLSearchParams("tab=public&template=t1"))).toEqual({ tab: "public", template: "t1", review: null, view: null });
    expect(parseTemplatesPageParams(new URLSearchParams("tab=junk"))).toEqual({ tab: "mine", template: null, review: null, view: null });
  });

  it("reads the chat card's ?review= link to a publish request's review panel", () => {
    expect(parseTemplatesPageParams(new URLSearchParams("tab=mine&review=req-1"))).toEqual({ tab: "mine", template: null, review: "req-1", view: null });
    expect(parseTemplatesPageParams(new URLSearchParams("review="))).toEqual({ tab: "mine", template: null, review: null, view: null });
  });
});

describe("the Cards / List view (D2)", () => {
  it("reads ?view=, and junk or nothing as absent", async () => {
    expect(parseTemplatesPageParams(new URLSearchParams("view=list")).view).toBe("list");
    expect(parseTemplatesPageParams(new URLSearchParams("view=cards")).view).toBe("cards");
    expect(parseTemplatesPageParams(new URLSearchParams("view=grid")).view).toBeNull();
    expect(parseTemplatesPageParams(new URLSearchParams("")).view).toBeNull();
  });

  it("resolveView: the URL wins, else the stored choice, else cards", async () => {
    const { resolveView, DEFAULT_TEMPLATES_VIEW, VIEW_STORAGE_KEY } = await import("@/components/templates/templates-page/use-templates-page-params");
    expect(DEFAULT_TEMPLATES_VIEW).toBe("cards");
    expect(VIEW_STORAGE_KEY).toBe("libi:templates-view");
    expect(resolveView("cards", "list")).toBe("cards");
    expect(resolveView(null, "list")).toBe("list");
    expect(resolveView(null, "junk")).toBe("cards");
    expect(resolveView(null, null)).toBe("cards");
  });
});
