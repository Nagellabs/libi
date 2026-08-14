// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverlayAssetPicker } from "@/components/preview/overlay-asset-picker";

vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [
    { id: "img1", filename: "logo.png", contentType: "image/png", pieceId: "p1" },
    { id: "vid1", filename: "clip.mp4", contentType: "video/mp4", pieceId: "p1" },
  ] }),
  useFileUpload: () => ({ upload: vi.fn(), isUploading: false }),
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("OverlayAssetPicker", () => {
  it("lists only image files for kind=image and picks one", () => {
    const onPick = vi.fn();
    wrap(<OverlayAssetPicker pieceId="p1" kind="image" open onOpenChange={() => {}} onPick={onPick} />);
    expect(screen.getByText("logo.png")).toBeInTheDocument();
    expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("logo.png"));
    expect(onPick).toHaveBeenCalledWith("img1");
  });
});
