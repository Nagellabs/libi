import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { GET, POST } from "@/app/api/folders/route";
import { PATCH, DELETE } from "@/app/api/folders/[folderId]/route";

function patchParams(folderId: string) {
  return { params: Promise.resolve({ folderId }) };
}

describe("/api/folders", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("POST creates a folder, GET lists it with pieceCount 0", async () => {
    const created = await (
      await POST(new Request("http://x/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "Campaign" }),
      }))
    ).json();
    expect(created.name).toBe("Campaign");

    const list = await (await GET()).json();
    expect(list.folders).toHaveLength(1);
    expect(list.folders[0].pieceCount).toBe(0);
  });

  it("POST rejects a blank name with 400", async () => {
    const res = await POST(new Request("http://x/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
    }));
    expect(res.status).toBe(400);
  });

  it("POST rejects a non-existent parentFolderId with 404 folder_not_found", async () => {
    const res = await POST(new Request("http://x/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: "X", parentFolderId: "does-not-exist" }),
    }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("folder_not_found");
  });

  it("PATCH rejects re-parenting to a non-existent folder with 404", async () => {
    const created = await (
      await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "f" }) }))
    ).json();
    const res = await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ parentFolderId: "does-not-exist" }),
      }),
      patchParams(created.id),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("folder_not_found");
  });

  it("PATCH renames a folder", async () => {
    const created = await (
      await POST(new Request("http://x/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "Old" }),
      }))
    ).json();
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "New" }) }),
      patchParams(created.id),
    );
    expect((await res.json()).name).toBe("New");
  });

  it("PATCH rejects a cycle with 409", async () => {
    const a = await (await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "a" }) }))).json();
    const b = await (await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "b", parentFolderId: a.id }) }))).json();
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ parentFolderId: b.id }) }),
      patchParams(a.id),
    );
    expect(res.status).toBe(409);
  });

  it("DELETE with mode=orphan removes the folder", async () => {
    const created = await (await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "f" }) }))).json();
    const res = await DELETE(
      new Request("http://x/api/folders/" + created.id + "?mode=orphan", { method: "DELETE" }),
      patchParams(created.id),
    );
    expect(res.status).toBe(200);
    expect((await (await GET()).json()).folders).toHaveLength(0);
  });
});
