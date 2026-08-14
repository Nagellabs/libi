export interface SendPromptResult { ok: boolean; byoCli?: boolean; sessionId?: string }
export interface SendPromptOpts { onSession?: (sessionId: string) => void }

/** POST a prompt to /api/agent/dispatch. Returns a structured result; the caller
 *  shows toasts. status 409 means bring-your-own-CLI (no in-app agent). */
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
  if (!res.ok) return { ok: false };
  const data = (await res.json().catch(() => ({}))) as { sessionId?: string };
  if (data.sessionId) opts.onSession?.(data.sessionId);
  return { ok: true, sessionId: data.sessionId };
}
