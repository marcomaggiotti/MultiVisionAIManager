// What the studio shows and how the player moves through it.
//
// Two situations share one set of controls:
// * capturing (camera / video running): Play/Pause pauses the capture itself, and the
//   paused frame can be inspected, stepped through and snapshotted;
// * not capturing: Play/Pause replays the recorded frames at their pace × speed.
import { useCallback, useEffect, useState } from "react";
import { PlayerState } from "./Timeline";
import { Recorded } from "./types";

const MIN_REPLAY_DELAY_MS = 15;
const MAX_REPLAY_DELAY_MS = 1000;

type LiveControls = {
  frames: Recorded[];
  version: number;
  isCapturing: boolean;
  capturePaused: boolean;
  pauseCapture: () => void;
  resumeCapture: () => void;
};

export function usePlayback(live: LiveControls) {
  const { frames, isCapturing, capturePaused } = live;
  const [following, setFollowing] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const shownIndex = following ? frames.length - 1 : Math.min(selectedIndex, frames.length - 1);
  const shownFrame = shownIndex >= 0 ? frames[shownIndex] : null;

  // Replay at the recorded pace, divided by the speed.
  useEffect(() => {
    if (!replaying || following) return;
    if (selectedIndex >= frames.length - 1) {
      setReplaying(false);
      return;
    }
    const recordedGapMs = (frames[selectedIndex + 1].result.t - frames[selectedIndex].result.t) * 1000;
    const delay = Math.min(MAX_REPLAY_DELAY_MS, Math.max(MIN_REPLAY_DELAY_MS, recordedGapMs / speed));
    const timer = window.setTimeout(() => setSelectedIndex((index) => index + 1), delay);
    return () => window.clearTimeout(timer);
  }, [replaying, selectedIndex, following, frames, speed, live.version]);

  /** Stop at the shown frame (pausing the capture if it runs). */
  const holdCurrentFrame = useCallback(() => {
    if (isCapturing && !capturePaused) live.pauseCapture();
    setSelectedIndex(shownIndex);
    setFollowing(false);
    setReplaying(false);
  }, [isCapturing, capturePaused, live, shownIndex]);

  const seek = useCallback((index: number) => {
    if (index < 0 || !frames.length) return;
    if (isCapturing && !capturePaused) live.pauseCapture();
    setFollowing(false);
    setSelectedIndex(Math.max(0, Math.min(frames.length - 1, index)));
  }, [frames.length, isCapturing, capturePaused, live]);

  const follow = useCallback(() => {
    if (isCapturing && capturePaused) live.resumeCapture();
    setFollowing(true);
    setReplaying(false);
  }, [isCapturing, capturePaused, live]);

  const togglePlay = useCallback(() => {
    if (isCapturing) {
      if (capturePaused) follow();
      else holdCurrentFrame();
      return;
    }
    if (replaying) {
      setReplaying(false);
      return;
    }
    if (shownIndex >= frames.length - 1) setSelectedIndex(0);
    else setSelectedIndex(shownIndex);
    setFollowing(false);
    setReplaying(true);
  }, [isCapturing, capturePaused, replaying, shownIndex, frames.length, follow, holdCurrentFrame]);

  const player: PlayerState = {
    playing: isCapturing ? !capturePaused : replaying,
    speed,
    following,
  };

  const reset = () => {
    setSelectedIndex(-1);
    setFollowing(true);
    setReplaying(false);
  };
  const startFollowing = () => {
    setFollowing(true);
    setReplaying(false);
  };
  return { shownIndex, shownFrame, player, togglePlay, seek, setSpeed, follow, holdCurrentFrame, reset, startFollowing };
}

export type Playback = ReturnType<typeof usePlayback>;
