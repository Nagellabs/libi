"use client";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {children}
      </div>
    </div>
  );
}

export function ScriptEmpty({ onGenerate }: { onGenerate: () => void }) {
  return (
    <Centered>
      <div className="text-2xl" aria-hidden>
        📜
      </div>
      <div className="text-sm font-medium text-foreground">
        This video hasn&apos;t been analyzed yet
      </div>
      {/* One-liner first — most people stop reading here. */}
      <p className="text-xs text-foreground/90">
        Give the agent a deep understanding of this video so it makes smarter
        generation and editing decisions.
      </p>
      {/* Detail for those who want the full picture. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        A Gemini-powered video-understanding model watches the full video and
        produces a detailed breakdown — a shot-by-shot script plus music and
        sound-design notes — which the agent uses when generating or editing,
        for example to re-create the video with AI models. Paid via fal.ai
        credits; cost depends on video length.
      </p>
      <button
        type="button"
        onClick={onGenerate}
        className="cursor-pointer mt-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        Generate AI analysis
      </button>
    </Centered>
  );
}

export function ScriptInProgress({
  done,
  total,
  onCancel,
}: {
  done: number;
  total: number;
  onCancel: () => void;
}) {
  // The runner reports progress via reportProgress(done, total, "step") at
  // four phase boundaries (extract → upload → submit → result). We surface
  // the numeric step rather than a textual note because the runner does not
  // currently thread the phase note through the progressUnit channel.
  const note = total > 0 ? `Step ${done} of ${total}` : "Starting…";
  return (
    <Centered>
      <div className="text-2xl" aria-hidden>
        ⏳
      </div>
      <div className="text-sm font-medium text-foreground">
        Generating AI analysis…
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
      <p className="text-[11px] text-muted-foreground">
        This usually takes 20–40 seconds.
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="cursor-pointer mt-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs hover:bg-surface-hover"
      >
        Cancel
      </button>
    </Centered>
  );
}

export function ScriptFailed({
  error,
  onRetry,
  onOpenChat,
}: {
  error: string;
  onRetry: () => void;
  onOpenChat: () => void;
}) {
  return (
    <Centered>
      <div className="text-2xl" aria-hidden>
        ⚠
      </div>
      <div className="text-sm font-medium text-foreground">
        AI analysis failed
      </div>
      <p className="max-w-prose break-words text-xs text-muted-foreground">
        {error.length > 300 ? `${error.slice(0, 300)}…` : error}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onOpenChat}
          className="cursor-pointer rounded-md border border-border bg-muted px-3 py-1.5 text-xs hover:bg-surface-hover"
        >
          Open chat
        </button>
      </div>
    </Centered>
  );
}
