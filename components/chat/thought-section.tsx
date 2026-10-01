"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface ThoughtSectionProps {
  text: string;
  /** True when the thought is still being produced (no subsequent content yet) */
  active: boolean;
}

// Thinking stays small and muted, so only the inline and block basics get a style.
// `pre-line` keeps the single line breaks Claude's prose thinking relies on, which
// markdown would otherwise fold into one line.
const components: Components = {
  p: ({ children }) => <p className="mb-2 whitespace-pre-line last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold not-italic">{children}</strong>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  code: ({ children }) => <code className="rounded bg-surface px-1 font-mono text-xs not-italic">{children}</code>,
  // A new tab, like the chat's own messages: in a browser tab (npx) a plain link
  // navigated the studio away mid-conversation.
  a: ({ href, children }) => (
    <a href={href} className="underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export default function ThoughtSection({ text, active }: ThoughtSectionProps) {
  const [userToggled, setUserToggled] = useState(false);
  const [userExpanded, setUserExpanded] = useState(true);

  const expanded = userToggled ? userExpanded : active;

  const handleToggle = () => {
    setUserToggled(true);
    setUserExpanded((prev) => !prev);
  };

  return (
    <div className="mt-1">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 text-sm text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer py-1"
      >
        <span className="text-xs">{expanded ? "▾" : "▸"}</span>
        <span className="italic">thinking</span>
        {active && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground/50" />
        )}
      </button>
      <div
        className="overflow-hidden transition-all duration-200"
        style={{
          maxHeight: expanded ? "500px" : "0px",
          opacity: expanded ? 1 : 0,
        }}
      >
        {/* Rendered as markdown and trimmed: Codex streams each reasoning summary as a
            "\n\n" section break plus a **bold** title, which printed raw was a tall blank
            gap under "thinking" and literal asterisks. */}
        <div data-testid="thought-body" className="mt-1 text-sm leading-relaxed italic text-muted-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {text.trim()}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
