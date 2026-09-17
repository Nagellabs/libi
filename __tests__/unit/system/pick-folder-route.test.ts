import { describe, it, expect, vi, beforeEach } from "vitest";

const pick = vi.fn();
vi.mock("@/lib/system/pick-folder", () => ({ pickFolder: (opts: unknown) => pick(opts) }));
import { POST } from "@/app/api/system/pick-folder/route";

const URL_ = "http://127.0.0.1/api/system/pick-folder";
const post = (body: unknown, signal?: AbortSignal) =>
  POST(new Request(URL_, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal }));

describe("POST /api/system/pick-folder", () => {
  beforeEach(() => pick.mockReset());
  it("passes the initial path through and answers the pick", async () => {
    pick.mockResolvedValue({ status: "picked", path: "/p" });
    const res = await post({ initialPath: "/start" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "picked", path: "/p" });
    expect(pick).toHaveBeenCalledWith({ initialPath: "/start", signal: expect.any(AbortSignal) });
  });
  it("ignores a non-string initial path and an unparsable body", async () => {
    pick.mockResolvedValue({ status: "cancelled" });
    await post({ initialPath: 42 });
    expect(pick).toHaveBeenCalledWith({ initialPath: null, signal: expect.any(AbortSignal) });
    const res = await POST(new Request(URL_, { method: "POST", body: "{" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
  });
  it("hands the dialog the request's abort signal, so an abandoned request closes it", async () => {
    pick.mockResolvedValue({ status: "cancelled" });
    const controller = new AbortController();
    await post({ initialPath: "/start" }, controller.signal);
    const { signal } = pick.mock.calls[0][0] as { signal: AbortSignal };
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
  it("409 while a dialog is already open; unavailable is a 200 with its reason", async () => {
    pick.mockResolvedValue({ status: "busy" });
    expect((await post({})).status).toBe(409);
    pick.mockResolvedValue({ status: "unavailable", reason: "timed out" });
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unavailable", reason: "timed out" });
  });
});
