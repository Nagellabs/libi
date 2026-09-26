// @vitest-environment jsdom
// The templates-catalog view and switch (lib/queries/templates-catalog.ts): a
// switch resets every cloud-derived query rather than let an old catalog's
// answer land under the new one; a token never enters the cache; the legal
// links follow the catalog; other windows follow the route's refresh event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { templatesCatalogKeys, useLegalLinks, useSetTemplatesCatalog, useTemplatesCatalog } from "@/lib/queries/templates-catalog";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { LEGAL_LINKS } from "@/lib/legal-links";

const PROD = "https://libi.nagellabs.com";
const PREVIEW = "https://libi-site-git-templates-nagellabs.vercel.app";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const devView = (kind: "production" | "development", token = false) => ({
  devBuild: true,
  testMode: false,
  active: kind === "production" ? { kind, origin: PROD, host: "libi.nagellabs.com" } : { kind, origin: PREVIEW, host: new URL(PREVIEW).host },
  legalOrigin: kind === "production" ? PROD : PREVIEW,
  choice: kind,
  production: { origin: PROD, host: "libi.nagellabs.com" },
  development: { origin: PREVIEW, isDefault: false, defaultOrigin: null },
  bypassToken: { set: token, applies: token },
});

let fetchMock: ReturnType<typeof vi.fn>;
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { choice?: string; bypassToken?: string | null };
      return Response.json(devView((body.choice as "production" | "development") ?? "development", typeof body.bypassToken === "string"));
    }
    return Response.json(devView("production"));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("templates catalog queries", () => {
  it("a switch resets every templates query — lists, /mine, a public page — and the creator's approval", async () => {
    qc.setQueryData(["templates", "list", {}], ["old"]);
    qc.setQueryData(["templates", "cloud", "mine"], { templates: ["old"] });
    qc.setQueryData(["templates", "cloud", "detail", "abcdefghijklmnopqrst"], { old: true });
    qc.setQueryData(["templates-creator"], { status: "approved" });
    const { result } = renderHook(() => useSetTemplatesCatalog(), { wrapper });
    await result.current.mutateAsync({ choice: "development" });
    await waitFor(() => expect(qc.getQueryData(["templates", "list", {}])).toBeUndefined());
    expect(qc.getQueryData(["templates", "cloud", "mine"])).toBeUndefined();
    expect(qc.getQueryData(["templates", "cloud", "detail", "abcdefghijklmnopqrst"])).toBeUndefined();
    expect(qc.getQueryData(["templates-creator"])).toBeUndefined();
    expect(qc.getQueryData(templatesCatalogKeys.view)).toMatchObject({ active: { kind: "development" } });
  });

  it("setting a token changes no catalog: nothing is reset — and the token never enters the cache", async () => {
    qc.setQueryData(["templates", "list", {}], ["kept"]);
    const { result } = renderHook(() => useSetTemplatesCatalog(), { wrapper });
    await result.current.mutateAsync({ bypassToken: TOKEN });
    expect(qc.getQueryData(["templates", "list", {}])).toEqual(["kept"]);
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(TOKEN);
    expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state.data))).not.toContain(TOKEN);
  });

  it("the legal links follow the catalog: production's, the development site's own while it is active, the build's before the view loads", async () => {
    const { result } = renderHook(() => useLegalLinks(), { wrapper });
    expect(result.current).toBe(LEGAL_LINKS);
    await waitFor(() => expect(result.current.terms).toBe(`${PROD}/terms`));
    qc.setQueryData(templatesCatalogKeys.view, devView("development"));
    await waitFor(() => expect(result.current.terms).toBe(`${PREVIEW}/terms`));
    expect(result.current.templateReportForm("abcdefghijklmnopqrst")).toBe(`${PREVIEW}/templates/report?template=abcdefghijklmnopqrst`);
  });

  it("another window's switch (the route's refresh event) re-reads the view", async () => {
    const { result } = renderHook(() => useTemplatesCatalog(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(dispatchRefreshQueryData({ queryKey: "templates-catalog" }, qc)).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
