// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatPanel from "@/components/chat/chat-panel";
import { EditorStateProvider } from "@/lib/editor-state-context";

const uploadMock = vi.fn();
const toastError = vi.fn();
const sendMessage = vi.fn();
let lastUploadPieceId: string | null | undefined;

vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: "s1", setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  useAgentChat: () => ({
    messages: [], sendMessage, isStreaming: false, cancelStream: vi.fn(),
    error: null, isLoading: false, sessionReady: true, cancelMessage: vi.fn(),
    status: "idle",
  }),
  subscribeBroadcast: () => () => {},
  sessionContextEmitter: { on: () => () => {}, emit: vi.fn() },
  sessionModelEmitter: { on: () => () => {}, emit: vi.fn() },
}));
vi.mock("@/lib/queries/pieces", () => ({
  usePieces: () => ({ data: { pieces: [], openedPiece: null } }),
}));
vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  useGlobalFiles: () => ({ data: [] }),
  useFileUpload: (pieceId: string | null) => {
    lastUploadPieceId = pieceId;
    return { upload: uploadMock, isUploading: false };
  },
}));
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-scroll-to-bottom", () => ({
  useScrollToBottom: () => ({
    containerRef: { current: null }, isAtBottom: true,
    scrollToBottom: vi.fn(), restoreSavedPosition: vi.fn(),
  }),
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <EditorStateProvider>
        {/* "" is what the editor passes when no piece is open — the state the
            reported bug happened in. */}
        <ChatPanel sessionId="s1" />
      </EditorStateProvider>
    </QueryClientProvider>,
  );
}

/** Type `text`, attach one image, and press Send. */
function composeAndSend(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  return { textarea, file };
}

beforeEach(() => {
  localStorage.clear();
  uploadMock.mockReset();
  toastError.mockReset();
  sendMessage.mockReset();
  lastUploadPieceId = undefined;
});

describe("ChatPanel upload failure", () => {
  it("uploads chat attachments as UNASSIGNED, not into the open piece", () => {
    // Attaching a file is a way to SHOW the agent something; it is not a
    // decision that the file belongs to the piece. The agent moves it in with
    // libi.assign_file if it decides it does.
    renderPanel();
    expect(lastUploadPieceId).toBe(null);
  });

  it("gives the message and the attachment back, and says why", async () => {
    // handleSubmit clears the composer BEFORE awaiting the upload and had no
    // catch, so a failed upload destroyed the user's text and their file and
    // reported nothing — the error reached them only as an unhandled rejection.
    uploadMock.mockRejectedValue(new Error("Upload failed (405)"));
    const { container } = renderPanel();
    const { textarea } = composeAndSend(container, "make this a title card");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Upload failed (405)"));
    expect(textarea.value).toBe("make this a title card");
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends and clears normally when the upload succeeds", async () => {
    uploadMock.mockResolvedValue({
      id: "f1", filename: "shot.png", contentType: "image/png", size: 3,
      mediaDuration: null, mediaWidth: 640, mediaHeight: 480,
    });
    const { container } = renderPanel();
    const { textarea } = composeAndSend(container, "make this a title card");

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0][1][0].fileId).toBe("f1");
    expect(toastError).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });
});
