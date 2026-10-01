"use client";

/** A plan sentence: `*Title — Artist*` is the song, shown in italics. Plain text otherwise (never markup). */
export function MusicSentence({ text, testId = "music-sentence" }: { text: string; testId?: string }) {
  const parts = text.split(/\*([^*]+)\*/g);
  return (
    <p data-testid={testId} className="text-xs">
      {parts.map((p, i) => (i % 2 === 1 ? <em key={i}>{p}</em> : <span key={i}>{p}</span>))}
    </p>
  );
}
