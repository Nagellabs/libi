/**
 * Libi piece mark — a rounded video *frame* (centered in the icon box) with a
 * 4-point AI sparkle accenting its top-right corner. Drawn with `currentColor`
 * so it inherits the surrounding text color, and sized via `className`.
 *
 * Shared by the Resources panel header and every piece row in the file tree so
 * the panel reads as one unit.
 */
export function PieceMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* centered frame */}
      <rect x="5.5" y="5.5" width="13" height="13" rx="3.5" />
      {/* sparkle accent overflowing the top-right corner */}
      <path
        d="M19.2 1.4 C19.51 3.42 20.68 4.59 22.7 4.9 C20.68 5.21 19.51 6.38 19.2 8.4 C18.89 6.38 17.72 5.21 15.7 4.9 C17.72 4.59 18.89 3.42 19.2 1.4 Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
