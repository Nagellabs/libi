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
import { templatesCloudKeys } from "@/lib/queries/templates-cloud";
import { CREATOR_STATUS_REFRESH_KEY } from "@/lib/templates/cloud/constants";

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
