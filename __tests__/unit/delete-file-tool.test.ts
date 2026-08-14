import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const deleteFileMock = vi.fn();
vi.mock("@/lib/files/delete-file", () => ({
  deleteFile: (id: string) => deleteFileMock(id),
}));

beforeEach(() => deleteFileMock.mockReset());

describe("libi.delete_file MCP tool", () => {
  it("forwards to deleteFile() and returns success on cascade success", async () => {
    deleteFileMock.mockResolvedValueOnce({
      success: true, fileId: "f1", filename: "v.mp4",
      removedClips: ["c1"], removedOverlays: ["ov1"],
    });
    const { deleteFileTool } = await import("@/mcp/tools/file-delete-tool");
    const result = await deleteFileTool({ pieceId: "p1" }, { fileId: "f1", confirm: true });
    expect(result.success).toBe(true);
    expect(result.data?.removedOverlays).toEqual(["ov1"]);
    expect(deleteFileMock).toHaveBeenCalledWith("f1");
  });

  it("returns failure when the underlying helper failed", async () => {
    deleteFileMock.mockResolvedValueOnce({
      success: false, fileId: "missing", error: "File not found",
      removedClips: [], removedOverlays: [],
    });
    const { deleteFileTool } = await import("@/mcp/tools/file-delete-tool");
    const result = await deleteFileTool({ pieceId: "p1" }, { fileId: "missing", confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
