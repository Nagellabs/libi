import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalCapacityError } from "@/lib/terminal/manager";

const managerMock = {
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  close: vi.fn(),
};
vi.mock("@/lib/terminal/instance", () => ({
  getTerminalManager: () => managerMock,
}));

import { GET as listSessions, POST as createSession } from "@/app/api/terminal/sessions/route";
import { PATCH as renameSession, DELETE as deleteSession } from "@/app/api/terminal/sessions/[id]/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/terminal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("terminal REST routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET lists sessions from the manager", async () => {
    managerMock.list.mockReturnValue([{ id: "term-1" }]);
    const res = await listSessions(new Request("http://localhost/api/terminal/sessions"));
    expect(await res.json()).toEqual({ sessions: [{ id: "term-1" }] });
  });

  it("POST creates a session with the requested cliId", async () => {
    managerMock.create.mockReturnValue({ id: "term-1", cliId: "codex" });
    const res = await createSession(jsonRequest({ cliId: "codex" }));
    expect(res.status).toBe(201);
    expect(managerMock.create).toHaveBeenCalledWith({ cliId: "codex", purpose: "chat" });
    expect((await res.json()).id).toBe("term-1");
  });

  it("POST falls back to the default preset on an empty body", async () => {
    managerMock.create.mockReturnValue({ id: "term-1" });
    const res = await createSession(
      new Request("http://localhost/api/terminal/sessions", { method: "POST" }),
    );
    expect(res.status).toBe(201);
    expect(managerMock.create).toHaveBeenCalledWith({ cliId: "claude-code", purpose: "chat" });
  });

  it("POST returns 409 at capacity", async () => {
    managerMock.create.mockImplementation(() => {
      throw new TerminalCapacityError(50);
    });
    const res = await createSession(jsonRequest({ cliId: "shell" }));
    expect(res.status).toBe(409);
  });

  it("PATCH renames and 404s for unknown ids", async () => {
    managerMock.rename.mockReturnValue(true);
    const ok = await renameSession(jsonRequest({ title: "build box" }), params("term-1"));
    expect(ok.status).toBe(200);
    expect(managerMock.rename).toHaveBeenCalledWith("term-1", "build box");

    managerMock.rename.mockReturnValue(false);
    const missing = await renameSession(jsonRequest({ title: "x" }), params("term-9"));
    expect(missing.status).toBe(404);
  });

  it("PATCH rejects a missing/blank title", async () => {
    const res = await renameSession(jsonRequest({ title: "  " }), params("term-1"));
    expect(res.status).toBe(400);
    expect(managerMock.rename).not.toHaveBeenCalled();
  });

  it("DELETE closes and 404s for unknown ids", async () => {
    managerMock.close.mockReturnValue(true);
    const ok = await deleteSession(jsonRequest({}), params("term-1"));
    expect(ok.status).toBe(200);
    expect(managerMock.close).toHaveBeenCalledWith("term-1");

    managerMock.close.mockReturnValue(false);
    const missing = await deleteSession(jsonRequest({}), params("term-9"));
    expect(missing.status).toBe(404);
  });
});

describe("setup terminals over HTTP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET ?purpose=setup lists setup terminals; a bare GET lists chat ones", async () => {
    managerMock.list.mockImplementation((p?: string) => (p === "setup" ? [{ id: "s" }] : [{ id: "c" }]));
    const setup = await listSessions(new Request("http://localhost/api/terminal/sessions?purpose=setup"));
    expect(await setup.json()).toEqual({ sessions: [{ id: "s" }] });
    const chat = await listSessions(new Request("http://localhost/api/terminal/sessions"));
    expect(await chat.json()).toEqual({ sessions: [{ id: "c" }] });
  });

  it("POST passes purpose and surface through and strips newlines from initialInput", async () => {
    managerMock.create.mockReturnValue({ id: "term-9", purpose: "setup", surface: "agents" });
    const res = await createSession(
      jsonRequest({ cliId: "shell", purpose: "setup", surface: "agents", initialInput: "claude\r\nrm -rf /" }),
    );
    expect(res.status).toBe(201);
    expect(managerMock.create).toHaveBeenCalledWith({
      cliId: "shell",
      purpose: "setup",
      surface: "agents",
      initialInput: "claude rm -rf /",
    });
  });

  it("POST forces the plain shell for a setup terminal, whatever preset was asked for", async () => {
    managerMock.create.mockReturnValue({ id: "term-10", purpose: "setup", surface: "agents" });
    const res = await createSession(
      jsonRequest({ cliId: "claude-code", purpose: "setup", surface: "agents", initialInput: "claude mcp add libi" }),
    );
    expect(res.status).toBe(201);
    expect(managerMock.create).toHaveBeenCalledWith({
      cliId: "shell",
      purpose: "setup",
      surface: "agents",
      initialInput: "claude mcp add libi",
    });
  });

  it("POST rejects purpose=setup without a valid surface", async () => {
    const res = await createSession(jsonRequest({ cliId: "shell", purpose: "setup", surface: "kitchen" }));
    expect(res.status).toBe(400);
    expect(managerMock.create).not.toHaveBeenCalled();
  });

  it("POST ignores an unknown purpose (falls back to chat)", async () => {
    managerMock.create.mockReturnValue({ id: "t" });
    await createSession(jsonRequest({ cliId: "shell", purpose: "weird" }));
    expect(managerMock.create).toHaveBeenCalledWith({ cliId: "shell", purpose: "chat" });
  });
});
