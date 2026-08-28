import { ArrowDown } from "lucide-react";

interface ScrollToBottomPillProps {
  visible: boolean;
  /** Whether content actually ARRIVED after the user left the bottom. The
   *  control has two jobs — announce new content, and get back to the latest —
   *  and it has to say which one it is doing, or scrolling up through a chat
   *  the user has already read entirely announces messages that don't exist.
   *  Binary on purpose (no counter), and computed by the panel: this stays a
   *  presentational component with no idea what a message is. */
  hasNewMessages: boolean;
  onScrollToBottom: () => void;
}

export default function ScrollToBottomPill({
  visible,
  hasNewMessages,
  onScrollToBottom,
}: ScrollToBottomPillProps) {
  if (!visible) return null;

  return (
    <div className="sticky bottom-2 flex justify-center">
      <button
        onClick={onScrollToBottom}
        className="flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-colors hover:bg-primary/80"
      >
        <ArrowDown className="h-3 w-3" />
        {hasNewMessages ? "New messages" : "Jump to latest"}
      </button>
    </div>
  );
}
