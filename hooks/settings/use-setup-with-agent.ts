"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useEditorState } from "@/lib/editor-state-context";

export interface SetupRunInput {
  prompt: string;
}

export interface UseSetupWithAgentResult {
  run: (input: SetupRunInput) => Promise<{ sessionId: string }>;
  isPending: boolean;
  error: Error | null;
  /** true when an agent provider is currently selected */
  ready: boolean;
}

export function useSetupWithAgent(): UseSetupWithAgentResult {
  const { activeProviderId, sessionList } = useEditorState();
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const ready = activeProviderId != null;

  async function run(input: SetupRunInput): Promise<{ sessionId: string }> {
    if (!ready) {
      throw new Error("No agent selected");
    }

    setIsPending(true);
    setError(null);

    try {
      // 1. Create a new session.
      const sessionId = await sessionList.createSession();
      if (!sessionId) {
        throw new Error("Failed to create session");
      }

      // 2. Send the initial prompt to the agent.
      const sendRes = await fetch("/api/agent/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text: input.prompt }),
      });
      if (!sendRes.ok) {
        const body = await sendRes.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ??
            `Failed to send message (${sendRes.status})`,
        );
      }

      // 3. Switch the editor to the newly created session and navigate
      //    there so the user can watch progress + respond to approvals.
      //    setActiveSessionId is harmless if we're already on /editor;
      //    router.push triggers the page change when on /mcps-skills.
      sessionList.setActiveSessionId(sessionId);
      router.push("/editor");

      return { sessionId };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsPending(false);
    }
  }

  return { run, isPending, error, ready };
}
