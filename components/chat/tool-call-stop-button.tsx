"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

interface StopButtonProps {
  jobId: string;
  /** Optional callback after the cancel request returns. */
  onStop?: () => void;
}

async function cancelJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`cancel failed (${res.status})`);
}

export default function ToolCallStopButton({ jobId, onStop }: StopButtonProps) {
  const [confirmLeft, setConfirmLeft] = useState<number | null>(null);
  const mutation = useMutation({
    mutationFn: () => cancelJob(jobId),
    onSuccess: () => onStop?.(),
  });

  const counting = confirmLeft !== null;
  useEffect(() => {
    if (!counting) return;
    // One persistent interval per confirm session ticks the countdown down to
    // 0, then clears it — reverting the button to "stop" (the silent reset
    // becomes visible).
    const t = setInterval(
      () => setConfirmLeft((v) => (v === null || v <= 1 ? null : v - 1)),
      1000,
    );
    return () => clearInterval(t);
  }, [counting]);

  if (mutation.isPending) {
    return (
      <span className="text-[10px] text-muted-foreground/60">cancelling…</span>
    );
  }
  if (mutation.isSuccess) {
    return (
      <span className="text-[10px] text-muted-foreground/60">cancel requested</span>
    );
  }

  return (
    <button
      onClick={() => {
        if (confirmLeft === null) {
          setConfirmLeft(3);
          return;
        }
        setConfirmLeft(null);
        mutation.mutate();
      }}
      className="cursor-pointer text-[10px] text-destructive/70 hover:text-destructive underline-offset-2 hover:underline"
      aria-label={confirmLeft !== null ? "Confirm cancel" : "Cancel tool call"}
    >
      {confirmLeft !== null ? `click again to confirm (${confirmLeft})` : "stop"}
    </button>
  );
}
