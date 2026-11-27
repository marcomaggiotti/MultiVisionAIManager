import { useLayoutEffect, useRef, useState } from "react";

export type TimedText = { start: number; end: number; text: string };

/** How far the caption has been "sung": 0 when it appears (``anticipation`` before its
 * movement), 1 when its movement ends. Shared with the exported video. */
export function captionProgress(caption: TimedText, seconds: number, anticipation: number): number {
  const shownFrom = caption.start - anticipation;
  return Math.min(1, Math.max(0, (seconds - shownFrom) / Math.max(0.5, caption.end - shownFrom)));
}

/** Captions shown like karaoke: a two-line band always readable at the bottom of the video,
 * the words lighting up one after the other, the text scrolling up so the current word
 * stays in view (long captions never overflow). */
export function Karaoke({ captions, seconds, anticipation }: { captions: TimedText[]; seconds: number; anticipation: number }) {
  const inner = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const words = captions.flatMap((caption, number) => {
    const parts = caption.text.split(/\s+/).filter(Boolean);
    const sung = Math.floor(captionProgress(caption, seconds, anticipation) * parts.length);
    return parts.map((word, position) => ({ word, caption: number, sung: position < sung, first: position === 0 }));
  });
  const firstUnsung = words.findIndex((word) => !word.sung);
  const current = firstUnsung < 0 ? words.length - 1 : firstUnsung; // all sung: stay on the last word
  const key = captions.map((caption) => caption.text).join("|");

  // the line of the current word at the top of the band; the band stops at the last two lines
  useLayoutEffect(() => {
    const word = (index: number) => inner.current?.querySelector<HTMLElement>(`[data-word="${index}"]`);
    const element = word(current), first = word(0), last = word(words.length - 1);
    if (!inner.current || !element || !first || !last) return setOffset(0);
    const lineHeight = parseFloat(getComputedStyle(inner.current).lineHeight) || element.offsetHeight;
    const lastLine = last.offsetTop - first.offsetTop;
    setOffset(Math.max(0, Math.min(element.offsetTop - first.offsetTop, lastLine - lineHeight)));
  }, [current, key, words.length]);

  if (!words.length) return null;
  return (
    <div className="karaoke" aria-live="polite">
      <div className="karaoke-window">
        {/* a new set of captions starts in place (no scrolling back from the previous one) */}
        <div key={key} ref={inner} className="karaoke-inner" style={{ transform: `translateY(${-offset}px)` }}>
          {words.map((word, position) => (
            <span key={position}>
              {word.first && word.caption > 0 && <span className="karaoke-break" />}
              <span data-word={position} className={`karaoke-word ${word.sung ? "sung" : ""} ${position === current ? "now" : ""}`}>{word.word}</span>{" "}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
