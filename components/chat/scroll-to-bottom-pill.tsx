import { ArrowDown } from "lucide-react";

interface ScrollToBottomPillProps {
  visible: boolean;
  onScrollToBottom: () => void;
}

export default function ScrollToBottomPill({
  visible,
  onScrollToBottom,
}: ScrollToBottomPillProps) {
  if (!visible) return null;

  return (
    <div className="sticky bottom-2 flex justify-center">
      <button
        onClick={onScrollToBottom}
        className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-colors hover:bg-primary/80"
      >
        <ArrowDown className="h-3 w-3" />
        New messages
      </button>
    </div>
  );
}
