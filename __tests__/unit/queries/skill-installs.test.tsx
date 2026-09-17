// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let visible = true;
vi.mock("@/hooks/use-document-visible", () => ({ useDocumentVisible: () => visible }));

import {
  SkillInstallRequestError,
  installsFor,
  skillInstallKeys,
  useAddSkillInstall,
  useRemoveSkillInstall,
  useSkillInstalls,
} from "@/lib/queries/skill-installs";
import type { SkillInstallView, SkillInstallsResponse } from "@/lib/agents/skill-installs-types";

const fetchMock = vi.fn<typeof fetch>();
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

function view(over: Partial<SkillInstallView>): SkillInstallView {
  return { id: "i1", agentId: "claude-code", scope: "folder", path: "/p/.claude/skills", folderPath: "/p", source: "ui", status: "up-to-date", error: null, skippedNames: [], installedCount: 3, lastSyncedAt: null, ...over };
}
const response: SkillInstallsResponse = { installs: [view({})], userSkillsDirs: { "claude-code": "~/.claude/skills", codex: "~/.agents/skills" } };

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  visible = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("useSkillInstalls", () => {
  it("reads the list, polls every 5 s while visible and not at all while hidden", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const { result } = renderHook(() => useSkillInstalls({ poll: true }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(response));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/agents/skill-installs");
    const query = qc.getQueryCache().find({ queryKey: skillInstallKeys.all })!;
    expect(query.observers[0].options.refetchInterval).toBe(5000);
    visible = false;
    const hidden = renderHook(() => useSkillInstalls({ poll: true }), { wrapper });
    await waitFor(() => expect(hidden.result.current.data).toBeDefined());
    expect(query.observers.at(-1)!.options.refetchInterval).toBe(false);
  });
  it("installsFor splits one agent's rows into the user-level install and its folders", () => {
    const data: SkillInstallsResponse = {
      ...response,
      installs: [view({ id: "u", scope: "user", folderPath: null }), view({ id: "f1" }), view({ id: "c", agentId: "codex" })],
    };
    expect(installsFor(data, "claude-code")).toEqual({ user: data.installs[0], folders: [data.installs[1]] });
    expect(installsFor(data, "codex")).toEqual({ user: null, folders: [data.installs[2]] });
    expect(installsFor(undefined, "codex")).toEqual({ user: null, folders: [] });
  });
});

describe("mutations", () => {
  it("add posts the body, returns the install, and invalidates the list", async () => {
    const after: SkillInstallsResponse = { ...response, installs: [view({}), view({ id: "new" })] };
    let posted = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        posted = true;
        return new Response(JSON.stringify({ install: view({ id: "new" }) }), { status: 200 });
      }
      return new Response(JSON.stringify(posted ? after : response), { status: 200 });
    });
    // The mounted list is the active observer the invalidation refetches.
    const { result } = renderHook(() => ({ list: useSkillInstalls(), add: useAddSkillInstall() }), { wrapper });
    await waitFor(() => expect(result.current.list.data).toEqual(response));
    const install = await act(() => result.current.add.mutateAsync({ agentId: "claude-code", scope: "folder", folderPath: "/p" }));
    expect(install.id).toBe("new");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toBe("/api/agents/skill-installs");
    expect(JSON.parse(String(post[1]!.body))).toEqual({ agentId: "claude-code", scope: "folder", folderPath: "/p" });
    // onSettled hands its invalidation promise back to TanStack, so mutateAsync
    // resolves only once the refetched list is already in the cache — checked
    // straight from the cache, since the hook's own re-render is a separate,
    // independently-scheduled notification.
    expect(qc.getQueryData(skillInstallKeys.all)).toEqual(after);
    await waitFor(() => expect(result.current.list.data).toEqual(after));
  });
  it("a mutation that settles with nothing observing the list marks it stale, and the next mount reads the new rows", async () => {
    const after: SkillInstallsResponse = { ...response, installs: [] };
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ removed: 1 }), { status: 200 });
      return new Response(JSON.stringify(after), { status: 200 });
    });
    qc.setQueryData(skillInstallKeys.all, response);
    const { result } = renderHook(() => useRemoveSkillInstall(), { wrapper });
    await act(() => result.current.mutateAsync("i1"));
    await waitFor(() => expect(qc.getQueryState(skillInstallKeys.all)?.isInvalidated).toBe(true));
    const list = renderHook(() => useSkillInstalls(), { wrapper });
    await waitFor(() => expect(list.result.current.data).toEqual(after));
  });
  it("a poll already in flight when a remove settles cannot write the pre-remove rows back", async () => {
    const after: SkillInstallsResponse = { ...response, installs: [] };
    let releaseStalePoll!: () => void;
    const gets: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify(response), { status: 200 }),
      // The 5 s poll: started before the DELETE, answered with the old rows only after it.
      () =>
        new Promise<Response>((resolve) => {
          releaseStalePoll = () => resolve(new Response(JSON.stringify(response), { status: 200 }));
        }),
      async () => new Response(JSON.stringify(after), { status: 200 }),
    ];
    let getCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ removed: 1 }), { status: 200 });
      const next = gets[Math.min(getCount, gets.length - 1)];
      getCount += 1;
      return next();
    });
    const { result } = renderHook(() => ({ list: useSkillInstalls(), remove: useRemoveSkillInstall() }), { wrapper });
    await waitFor(() => expect(result.current.list.data).toEqual(response));
    act(() => {
      void result.current.list.refetch();
    });
    await waitFor(() => expect(getCount).toBe(2));

    await act(() => result.current.remove.mutateAsync("i1"));
    await waitFor(() => expect(result.current.list.data).toEqual(after));
    await act(async () => {
      releaseStalePoll();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.list.data, "the removed row must not come back, or a second Remove 404s").toEqual(after);
  });
  it("add surfaces the route's validation code and message", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "not_found", message: "That folder doesn't exist." }), { status: 400 }));
    const { result } = renderHook(() => useAddSkillInstall(), { wrapper });
    await expect(result.current.mutateAsync({ agentId: "codex", scope: "folder", folderPath: "/nope" })).rejects.toMatchObject({
      name: "SkillInstallRequestError",
      code: "not_found",
      message: "That folder doesn't exist.",
    });
    expect(new SkillInstallRequestError("request_failed", "x").code).toBe("request_failed");
  });
  it("add surfaces the route's invalid_body and install_failed codes untouched by any cast", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_body", message: "Expected a JSON object." }), { status: 400 }));
    const { result: badBody } = renderHook(() => useAddSkillInstall(), { wrapper });
    await expect(badBody.current.mutateAsync({ agentId: "codex", scope: "folder", folderPath: "/nope" })).rejects.toMatchObject({
      name: "SkillInstallRequestError",
      code: "invalid_body",
      message: "Expected a JSON object.",
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "install_failed", message: "disk full" }), { status: 500 }));
    const { result: serverFail } = renderHook(() => useAddSkillInstall(), { wrapper });
    await expect(serverFail.current.mutateAsync({ agentId: "codex", scope: "folder", folderPath: "/nope" })).rejects.toMatchObject({
      name: "SkillInstallRequestError",
      code: "install_failed",
      message: "disk full",
    });
  });
  it("remove deletes by id and invalidates the list", async () => {
    const after: SkillInstallsResponse = { ...response, installs: [] };
    let deleted = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response(JSON.stringify({ removed: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify(deleted ? after : response), { status: 200 });
    });
    const { result } = renderHook(() => ({ list: useSkillInstalls(), remove: useRemoveSkillInstall() }), { wrapper });
    await waitFor(() => expect(result.current.list.data).toEqual(response));
    await expect(act(() => result.current.remove.mutateAsync("i1"))).resolves.toEqual({ removed: 2 });
    expect(String(fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")![0])).toBe("/api/agents/skill-installs/i1");
    // onSettled hands its invalidation promise back to TanStack, so mutateAsync
    // resolves only once the refetched (empty) list is already in the cache —
    // checked straight from the cache, since the hook's own re-render is a
    // separate, independently-scheduled notification.
    expect(qc.getQueryData(skillInstallKeys.all)).toEqual(after);
    await waitFor(() => expect(result.current.list.data).toEqual(after));
  });
  it("remove surfaces the route's error code and message on a 500", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "install_failed", message: "permission denied" }), { status: 500 }),
    );
    const { result } = renderHook(() => useRemoveSkillInstall(), { wrapper });
    await expect(result.current.mutateAsync("i1")).rejects.toMatchObject({
      name: "SkillInstallRequestError",
      code: "install_failed",
      message: "permission denied",
    });
  });
  it("remove reports a 404 with no message as already gone", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const { result } = renderHook(() => useRemoveSkillInstall(), { wrapper });
    await expect(result.current.mutateAsync("i1")).rejects.toMatchObject({
      name: "SkillInstallRequestError",
      code: "not_found",
      message: "That install is already gone.",
    });
  });
  it("remove falls back to a generic message when the body isn't JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 500 }));
    const { result } = renderHook(() => useRemoveSkillInstall(), { wrapper });
    await expect(result.current.mutateAsync("i1")).rejects.toMatchObject({
      name: "SkillInstallRequestError",
      code: "request_failed",
      message: "Couldn't remove libi's skills. Try again.",
    });
  });
});
