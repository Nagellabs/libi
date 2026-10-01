/**
 * `refresh_query { queryKey: "templates" }` is what every template WRITE emits
 * — the MCP tools (`mcp/notify.ts`) and the PATCH/DELETE routes alike. It must
 * land as ONE invalidation of the `["templates"]` prefix, which covers both the
 * list keys and a detail key.
 */
import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { templateKeys } from "@/lib/queries/templates";
import { __publicDetailBackoffUntilForTests, __resetPublicDetailBackoffForTests, __setPublicDetailBackoffForTests, templatesCloudKeys } from "@/lib/queries/templates-cloud";
import { CREATOR_STATUS_REFRESH_KEY, TEMPLATES_CATALOG_REFRESH_KEY } from "@/lib/templates/cloud/constants";

describe("refresh_query templates", () => {
  it("invalidates the templates prefix and reports handled", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    expect(dispatchRefreshQueryData({ queryKey: "templates" }, qc)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: templateKeys.all });
  });

  // Review M7: the creator's approval costs a site request per re-read (10/min, shared with the publish gate).
  it("does not re-read the creator's approval: its key sits outside the templates prefix", async () => {
    const qc = new QueryClient();
    const queryFn = vi.fn(async () => ({ status: "approved" }));
    await qc.fetchQuery({ queryKey: templatesCloudKeys.creator, queryFn });
    const observer = qc.getQueryCache().find({ queryKey: templatesCloudKeys.creator })!;
    dispatchRefreshQueryData({ queryKey: "templates" }, qc);
    expect(observer.state.isInvalidated).toBe(false);
    expect(templatesCloudKeys.creator[0]).not.toBe(templateKeys.all[0]);
  });
});

// Review M9: a dev build switched catalogs in ANOTHER window. The old site's
// slow-down is its own: this window forgets it too, as the switching one does
// (lib/queries/templates-catalog.ts), instead of answering "slow down" for up
// to ten minutes against a catalog that never limited it.
describe("refresh_query templates-catalog", () => {
  it("re-reads which catalog is active and forgets the public detail backoff", () => {
    __setPublicDetailBackoffForTests(Date.now() + 10 * 60_000);
    expect(__publicDetailBackoffUntilForTests()).toBeGreaterThan(Date.now());
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    expect(dispatchRefreshQueryData({ queryKey: TEMPLATES_CATALOG_REFRESH_KEY }, qc)).toBe(true);
    expect(spy.mock.calls).toEqual([[{ queryKey: [TEMPLATES_CATALOG_REFRESH_KEY] }]]);
    expect(__publicDetailBackoffUntilForTests()).toBe(0);
    __resetPublicDetailBackoffForTests();
  });

  it("a plain templates refresh (an install, a write) keeps the backoff: the catalog is the same one", () => {
    const until = Date.now() + 60_000;
    __setPublicDetailBackoffForTests(until);
    dispatchRefreshQueryData({ queryKey: "templates" }, new QueryClient());
    expect(__publicDetailBackoffUntilForTests()).toBe(until);
    __resetPublicDetailBackoffForTests();
  });
});

describe("refresh_query templates-creator", () => {
  it("invalidates the creator's approval, and only it", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    expect(dispatchRefreshQueryData({ queryKey: CREATOR_STATUS_REFRESH_KEY }, qc)).toBe(true);
    expect(spy.mock.calls).toEqual([[{ queryKey: templatesCloudKeys.creator }]]);
  });

  it("leaves unrelated keys alone", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    expect(dispatchRefreshQueryData({ queryKey: "not-a-real-key" }, qc)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
