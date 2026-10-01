export interface SendPromptResult {
  ok: boolean;
  byoCli?: boolean;
  sessionId?: string;
  /** Why the prompt wasn't sent, when the server said (e.g. the new chat's approval mode is held). */
  error?: string;
}
export interface SendPromptOpts { onSession?: (sessionId: string) => void }

/** POST a prompt to /api/agent/dispatch. Returns a structured result; the caller
 *  shows toasts. status 409 means bring-your-own-CLI (no in-app agent); any other non-OK answer
 *  carries the server's `error` (and the chat it created, if any) so the toast can say why. */
export async function sendPromptToAgent(prompt: string, opts: SendPromptOpts = {}): Promise<SendPromptResult> {
  let res: Response;
  try {
    res = await fetch("/api/agent/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    return { ok: false };
  }
  if (res.status === 409) return { ok: false, byoCli: true };
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; sessionId?: unknown };
    const result: SendPromptResult = { ok: false };
    if (typeof data.error === "string" && data.error) result.error = data.error;
    if (typeof data.sessionId === "string" && data.sessionId) result.sessionId = data.sessionId;
    return result;
  }
  const data = (await res.json().catch(() => ({}))) as { sessionId?: string };
  if (data.sessionId) opts.onSession?.(data.sessionId);
  return { ok: true, sessionId: data.sessionId };
}
