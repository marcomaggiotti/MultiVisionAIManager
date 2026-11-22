// Keyboard shortcuts of the player, active while the live studio page is shown.
import { useEffect } from "react";
import { frameIndexAtTime } from "./Timeline";
import { Recorded } from "./types";
import { Playback } from "./usePlayback";

const ARROW_STEP_SECONDS = 1;
const SHIFT_ARROW_STEP_SECONDS = 3;

/** Space play/pause · ←/→ 1 s (Shift: 3 s) · , . one frame · Home/End · S snapshot · E adjust keypoints.
 * Ignored while typing in a field, inside a dialog, or when ``enabled`` is false. */
export function usePlayerKeyboard(
  frames: Recorded[],
  playback: Playback,
  shortcuts: { snapshot: () => void; adjustKeypoints: () => void },
  enabled: boolean,
) {
  const { shownIndex, shownFrame, togglePlay, seek } = playback;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true], .modal")) return;
      const currentTime = shownFrame?.result.t ?? 0;
      const stepSeconds = event.shiftKey ? SHIFT_ARROW_STEP_SECONDS : ARROW_STEP_SECONDS;
      const handlers: Record<string, () => void> = {
        " ": togglePlay,
        ArrowLeft: () => seek(frameIndexAtTime(frames, currentTime - stepSeconds)),
        ArrowRight: () => seek(frameIndexAtTime(frames, currentTime + stepSeconds)),
        ",": () => seek(shownIndex - 1),
        ".": () => seek(shownIndex + 1),
        Home: () => seek(0),
        End: () => seek(frames.length - 1),
        s: shortcuts.snapshot,
        S: shortcuts.snapshot,
        e: shortcuts.adjustKeypoints,
        E: shortcuts.adjustKeypoints,
      };
      const handler = handlers[event.key];
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, togglePlay, seek, shortcuts, frames, shownIndex, shownFrame]);
}
