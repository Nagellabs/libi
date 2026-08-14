"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { extractSections, slugifyHeading } from "@/lib/instructions/toc";

/** Flatten a ReactMarkdown children tree to plain text for slugging. */
function nodeText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    return nodeText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

/** Internal injection markers (e.g. `<!-- libi-instructions-start v1.15.0 -->`)
 *  are plumbing for workspace generation — hide them from the rendered doc.
 *  The raw content (incl. markers) is what edit mode and the API expose. */
const MARKER_COMMENT_RE = /^<!--\s*libi-[a-z-]+(?:\s+v[\d.]+)?\s*-->\s*$/gm;

export const MarkdownDoc = memo(function MarkdownDoc({ content }: { content: string }) {
  const display = useMemo(() => content.replace(MARKER_COMMENT_RE, ""), [content]);
  // Heading ids must be PURE — derived from the heading's source line, never
  // from render-invocation order. Any mutable dedup counter drifts ids on
  // re-renders (StrictMode double-renders included) and breaks the TOC's
  // querySelector contract. extractSections is the single id authority; the
  // marker-stripping above preserves line numbers, so ids match the TOC's.
  const idByLine = useMemo(
    () => new Map(extractSections(display).map((s) => [s.line, s.id])),
    [display],
  );
  const components = useMemo<Components>(() => {
    return {
      h1: ({ children }) => (
        <h1 className="mb-4 mt-8 text-2xl font-semibold first:mt-0">{children}</h1>
      ),
      h2: ({ node, children }) => {
        const line = node?.position?.start.line;
        const id = (line !== undefined ? idByLine.get(line) : undefined)
          ?? slugifyHeading(nodeText(children));
        return (
          <h2
            id={id}
            data-doc-section
            className="mb-3 mt-10 scroll-mt-6 border-b border-border pb-2 text-xl font-semibold first:mt-0"
          >
            {children}
          </h2>
        );
      },
      h3: ({ children }) => (
        <h3 className="mb-2 mt-6 text-base font-semibold">{children}</h3>
      ),
      h4: ({ children }) => (
        <h4 className="mb-2 mt-4 text-sm font-semibold">{children}</h4>
      ),
      p: ({ children }) => (
        <p className="mb-3 text-sm leading-6 text-foreground/90 last:mb-0">{children}</p>
      ),
      ul: ({ children }) => (
        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm leading-6 last:mb-0">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm leading-6 last:mb-0">{children}</ol>
      ),
      li: ({ children }) => <li>{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="mb-3 border-l-2 border-border pl-3 text-sm text-muted-foreground">
          {children}
        </blockquote>
      ),
      table: ({ children }) => (
        <div className="mb-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th className="border border-border bg-muted/40 px-2 py-1 text-left font-medium">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="border border-border px-2 py-1 align-top">{children}</td>
      ),
      code: ({ className, children, ...props }) => {
        const isBlock = className?.includes("language-");
        if (isBlock) {
          return (
            <code
              className="block overflow-x-auto rounded-lg bg-muted/50 p-3 text-xs font-mono"
              {...props}
            >
              {children}
            </code>
          );
        }
        return (
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-xs font-mono" {...props}>
            {children}
          </code>
        );
      },
      pre: ({ children }) => <pre className="mb-3 last:mb-0">{children}</pre>,
      a: ({ href, children }) => (
        <a
          href={href}
          className="cursor-pointer text-primary underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      ),
      hr: () => <hr className="my-6 border-border" />,
    };
  }, [idByLine]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {display}
    </ReactMarkdown>
  );
});
