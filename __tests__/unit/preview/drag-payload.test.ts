import { describe, it, expect } from "vitest";
import { LIBI_FILE_MIME, encodeFileDrag, decodeFileDrag } from "@/lib/preview/drag-payload";

describe("file drag payload", () => {
  it("round-trips fileId + contentType", () => {
    const enc = encodeFileDrag({ fileId: "f1", contentType: "image/png" });
    expect(decodeFileDrag(enc)).toEqual({ fileId: "f1", contentType: "image/png" });
  });
  it("decode of junk → null", () => {
    expect(decodeFileDrag("not json")).toBeNull();
  });
  it("exposes the custom mime", () => {
    expect(LIBI_FILE_MIME).toBe("application/x-libi-file");
  });
});
