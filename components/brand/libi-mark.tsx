import { cn } from "@/lib/utils";

export function LibiMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("inline-block", className)}
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="16" r="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="20" cy="16" r="3.2" fill="currentColor" />
    </svg>
  );
}
