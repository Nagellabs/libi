import { describe, it, expect, vi, beforeEach } from "vitest";

const add = vi.fn();
const remove = vi.fn();
const list = vi.fn();
vi.mock("@/mcp/skills/installs", () => ({
  addSkillInstall: (i: unknown) => add(i),
  removeSkillInstall: (id: string) => remove(id),
  skillInstallsResponse: () => list(),
  shortInstallError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  SkillInstallError: class SkillInstallError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = "SkillInstallError"; }
  },
}));
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => logError(...a) },
}));

import { SkillInstallError } from "@/mcp/skills/installs";
import { GET, POST } from "@/app/api/agents/skill-installs/route";
import { DELETE } from "@/app/api/agents/skill-installs/[id]/route";

const post = (body: unknown) =>
  POST(new Request("http://127.0.0.1/api/agents/skill-installs", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const postRaw = (body: string) =>
  POST(new Request("http://127.0.0.1/api/agents/skill-installs", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
const del = (id: string) => DELETE(new Request(`http://127.0.0.1/api/agents/skill-installs/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  add.mockReset();
  remove.mockReset();
  list.mockReset();
  logError.mockReset();
});

describe("/api/agents/skill-installs", () => {
  it("GET answers the list with the user dirs", async () => {
    list.mockResolvedValue({ installs: [], userSkillsDirs: { "claude-code": "~/.claude/skills", codex: "~/.agents/skills" } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installs: [], userSkillsDirs: { "claude-code": "~/.claude/skills", codex: "~/.agents/skills" } });
  });
  it("POST user scope and folder scope, always source ui", async () => {
    add.mockResolvedValue({ id: "x" });
    expect((await post({ agentId: "codex", scope: "user" })).status).toBe(200);
    expect(add).toHaveBeenCalledWith({ agentId: "codex", scope: "user", source: "ui" });
    const res = await post({ agentId: "claude-code", scope: "folder", folderPath: "/p" });
    expect(await res.json()).toEqual({ install: { id: "x" } });
    expect(add).toHaveBeenCalledWith({ agentId: "claude-code", scope: "folder", folderPath: "/p", source: "ui" });
  });
  it("POST rejects an unknown agent and a malformed body without calling the service", async () => {
    expect((await post({ agentId: "gemini", scope: "user" })).status).toBe(400);
    expect(await (await post({ agentId: "gemini", scope: "user" })).json()).toEqual({ error: "unknown_agent", message: "Unknown agent." });
    expect((await post({ agentId: "codex", scope: "folder" })).status).toBe(400);
    expect((await post({ agentId: "codex", scope: "nope" })).status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });
  it("POST maps a service error to 400 with its code and message", async () => {
    add.mockRejectedValue(new SkillInstallError("refused_home", "That's your home folder. To install libi's skills for every folder, choose Every folder."));
    const res = await post({ agentId: "codex", scope: "folder", folderPath: "/Users/me" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "refused_home", message: "That's your home folder. To install libi's skills for every folder, choose Every folder." });
  });
  it("POST maps a reverse-link refusal to 400 with linked_to_libi", async () => {
    add.mockRejectedValue(
      new SkillInstallError(
        "linked_to_libi",
        "libi's skills folder for every folder links into libi's own agent folder. Remove that link, then install again.",
      ),
    );
    const res = await post({ agentId: "codex", scope: "user" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "linked_to_libi",
      message: "libi's skills folder for every folder links into libi's own agent folder. Remove that link, then install again.",
    });
  });
  it("DELETE answers the count, 404 for an unknown id", async () => {
    remove.mockResolvedValue({ removed: 3 });
    expect(await (await del("abc")).json()).toEqual({ removed: 3 });
    expect(remove).toHaveBeenCalledWith("abc");
    remove.mockResolvedValue(null);
    expect((await del("nope")).status).toBe(404);
  });
  it("DELETE maps a service refusal to 400 with its code and message, not a 500", async () => {
    remove.mockRejectedValue(new SkillInstallError("not_writable", "libi won't write or remove skills through a linked skills folder."));
    const res = await del("abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_writable", message: "libi won't write or remove skills through a linked skills folder." });
    expect(logError).not.toHaveBeenCalled();
  });
  it("POST answers 500 with no stack for a raw service error, and logs it", async () => {
    add.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    const res = await post({ agentId: "codex", scope: "user" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "install_failed", message: "ENOENT: no such file or directory" });
    expect(logError).toHaveBeenCalled();
  });
  it("DELETE answers 500 with no stack for a raw service error, and logs it", async () => {
    remove.mockRejectedValue(new Error("EACCES: permission denied"));
    const res = await del("abc");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "install_failed", message: "EACCES: permission denied" });
    expect(logError).toHaveBeenCalled();
  });
  it("GET answers 500 with a short message for a failing list, and logs it", async () => {
    list.mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "install_failed", message: "SQLITE_BUSY: database is locked" });
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ tag: "skills", op: "installs_list_failed" }), expect.any(String));
  });
  it("POST answers invalid_body for invalid JSON and for JSON that is not an object", async () => {
    for (const raw of ["{not json", "null", "[]", '[{"agentId":"codex","scope":"user"}]', "42", '"codex"']) {
      const res = await postRaw(raw);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_body");
      expect(typeof body.message).toBe("string");
    }
    expect(add).not.toHaveBeenCalled();
  });
  it("POST answers unknown_agent for a non-string agentId and invalid_body for a non-string folderPath", async () => {
    for (const agentId of [42, null, ["codex"], { id: "codex" }]) {
      const res = await post({ agentId, scope: "user" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("unknown_agent");
    }
    for (const folderPath of [42, null, ["/p"], { path: "/p" }]) {
      const res = await post({ agentId: "codex", scope: "folder", folderPath });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_body");
    }
    expect(add).not.toHaveBeenCalled();
  });
});
