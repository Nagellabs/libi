import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  getDb: () => {
    throw new Error("DB must not be touched when apiKey is passed");
  },
}));

import { transcribeAudio } from "@/lib/elevenlabs/transcribe";

describe("elevenlabs transcribeAudio apiKey param", () => {
  it("uses the passed apiKey and does NOT hit the DB", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            language_code: "en",
            language_probability: 0.9,
            text: "hi",
            words: [],
          }),
          { status: 200 },
        ),
      );
    const res = await transcribeAudio({
      audioPath: "__tests__/fixtures/audio/jfk.wav",
      apiKey: "test-key-123",
    });
    expect(res.text).toBe("hi");
    const call = fetchSpy.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("test-key-123");
    fetchSpy.mockRestore();
  });
});
