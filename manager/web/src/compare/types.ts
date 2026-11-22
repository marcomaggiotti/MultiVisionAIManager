import { Box } from "../live/types";

export type MatchStatus = "ok" | "warn" | "bad";
export type MirrorMode = "auto" | "same" | "mirrored";

export type TrackedDancer = {
  dancer: { box: Box; confidence: number; keypoints: number[][] } | null;
  angles: Record<string, number | null> | null;
  movement: string | null;
  image: { width: number; height: number } | null;
  adjusted?: boolean;
};

export type JointComparison = {
  joint: string;
  label: string;
  part: string;
  reference: number;
  student: number;
  difference: number; // student - reference, degrees
  status: MatchStatus;
  score: number;
  advice: string;
};

export type ComparisonStatistics = {
  match_score: number | null; // smoothed, live
  average_score: number | null;
  best_score: number;
  in_step_share: number | null;
  frames_compared: number;
  part_problems: Record<string, number>;
};

export type ComparisonResult = ComparisonStatistics & {
  type: "comparison";
  frame: number;
  t: number;
  reference_time: number | null;
  reference: TrackedDancer;
  student: TrackedDancer;
  comparison: {
    score: number | null;
    mirrored: boolean;
    delay_s: number | null;
    joints: JointComparison[];
    parts: Record<string, MatchStatus>;
    corrections: { joint: string; part: string; status: MatchStatus; message: string }[];
  } | null;
  latency_ms: { yolo: number; total: number };
};

export type ComparisonSettings = {
  good_degrees: number;
  fair_degrees: number;
  mirror: MirrorMode;
  max_delay: number;
  smoothing: number;
  detection_confidence: number;
};

export const DEFAULT_COMPARISON_SETTINGS: ComparisonSettings = {
  good_degrees: 15, fair_degrees: 30, mirror: "auto", max_delay: 0.6, smoothing: 0.4, detection_confidence: 0.3,
};

export const MATCH_COLOR: Record<MatchStatus | "none", string> = { ok: "#3ddc84", warn: "#ffb547", bad: "#ff5d6c", none: "#5b6680" };

/** Green from 80 %, yellow from 55 %, red below (the same bands as the joints). */
export const scoreStatus = (score: number | null | undefined): MatchStatus | "none" =>
  score == null ? "none" : score >= 80 ? "ok" : score >= 55 ? "warn" : "bad";

export const PART_LABEL: Record<string, string> = {
  left_leg: "Left leg", right_leg: "Right leg", left_arm: "Left arm", right_arm: "Right arm", torso: "Torso", hips: "Hips",
};
