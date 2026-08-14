import { describe, it, expect } from "vitest";
import { resolvePiecesScreen } from "@/lib/pieces/pieces-screen";

const state = (over: Partial<Parameters<typeof resolvePiecesScreen>[0]> = {}) => ({
  hasActivePiece: false,
  isError: false,
  data: undefined as readonly unknown[] | undefined,
  ...over,
});

describe("resolvePiecesScreen", () => {
  it("NEVER claims an empty library when the request failed", () => {
    // The reported bug: a user with a dozen pieces saw "Welcome to libi —
    // create your first piece" because GET /api/pieces was 500ing and the old
    // condition read `(data ?? []).length === 0`.
    expect(resolvePiecesScreen(state({ isError: true, data: undefined }))).toBe(
      "unavailable",
    );
  });

  it("says welcome only when the load SUCCEEDED and found nothing", () => {
    expect(resolvePiecesScreen(state({ data: [] }))).toBe("welcome");
  });

  it("renders the editor when pieces exist", () => {
    expect(resolvePiecesScreen(state({ data: [{ id: "a" }] }))).toBeNull();
  });

  it("shows nothing special while the first load is still in flight", () => {
    // data undefined + no error = still loading. Showing "welcome" here is the
    // flash-of-empty-state that made the bug easy to believe.
    expect(resolvePiecesScreen(state())).toBeNull();
  });

  it("keeps showing the data it has when a REFETCH fails", () => {
    // React Query holds the last good data through a failed refetch. Throwing
    // the user to a full-page error over a blip — while a perfectly good list
    // is in hand — would be its own kind of dishonesty.
    expect(
      resolvePiecesScreen(state({ isError: true, data: [{ id: "a" }] })),
    ).toBeNull();
    // ...and a refetch that fails after a genuinely empty load still says
    // welcome, because that is what we last actually knew.
    expect(resolvePiecesScreen(state({ isError: true, data: [] }))).toBe("welcome");
  });

  it("defers to the open piece — an error is not worth blanking real work", () => {
    expect(
      resolvePiecesScreen(state({ hasActivePiece: true, isError: true })),
    ).toBeNull();
    expect(
      resolvePiecesScreen(state({ hasActivePiece: true, data: [] })),
    ).toBeNull();
  });
});
