"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useEditorState } from "@/lib/editor-state-context";
import { sendPromptToAgent } from "@/lib/agents/send-prompt-to-agent";

/**
 * Drives the shared "send this prompt to the agent" dialog. Use anywhere the
 * UI wants to hand a NON-internal task to the agent:
 *
 *   const dispatch = useDispatchToAgent();
 *   <button onClick={() => dispatch.openWith(promptText)}>…</button>
 *   <DispatchToAgentDialog {...dispatch} prompt={dispatch.prompt} />
 *
 * "Send" POSTs /api/agent/dispatch, then switches the chat to the new session
 * (the agent often replies with a question — e.g. a paid-tool cost
 * confirmation — that the user must see). In bring-your-own-CLI mode the
 * route returns 409 and we show a friendly toast (NOT an error) nudging the
 * user to copy the prompt into their own CLI. "Copy" uses the clipboard.
 */
export function useDispatchToAgent() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const { sessionList, chatVisible, toggleChat } = useEditorState();

  const openWith = useCallback((p: string) => {
    setPrompt(p);
    setOpen(true);
  }, []);

  const { switchSession, refresh } = sessionList;
  // Returns whether the prompt was actually handed to the agent — false for
  // both the BYO-CLI no-op and a request failure. Callers that need to know
  // the dispatch actually happened (e.g. to fire analytics only on a real
  // send, not on every open of this dialog) key off this instead of the
  // toast side effects.
  const send = useCallback(async (): Promise<boolean> => {
    setSending(true);
    try {
      const r = await sendPromptToAgent(prompt, {
        // Follow the conversation: select the dispatched session and make sure
        // the chat panel is on screen.
        onSession: (sessionId) => {
          switchSession(sessionId);
          refresh();
          if (!chatVisible) toggleChat();
        },
      });
      if (r.byoCli) {
        toast.info("No libi agent is running", {
          description:
            "You're in bring-your-own-CLI mode. Copy the prompt and paste it into your CLI.",
        });
        return false;
      }
      if (!r.ok) {
        toast.error("Couldn't send to the agent");
        return false;
      }
      toast.success("Sent to the libi agent");
      setOpen(false);
      return true;
    } finally {
      setSending(false);
    }
  }, [prompt, switchSession, refresh, chatVisible, toggleChat]);

  // Same signal as `send`, for the same reason: true only when the prompt
  // actually made it to the clipboard.
  const copy = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("Prompt copied to clipboard");
      return true;
    } catch {
      toast.error("Clipboard not available");
      return false;
    }
  }, [prompt]);

  return { open, setOpen, prompt, openWith, send, copy, sending };
}
