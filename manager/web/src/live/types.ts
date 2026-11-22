export type Status = "ok" | "warn" | "bad" | "none";
export type Feedback = { part: string; status: Exclude<Status, "none">; message: string; value: number | null; target: string | null };
export type Candidate = { step: string; score: number; family: string };
export type Evaluation = {
  angles: Record<string, number | null>;
  working_side: string | null;
  visible_keypoints: number;
  candidates: Candidate[];
  pose: Candidate | null;
  feedback: Feedback[];
  parts: Record<string, Status>;
};
export type Box = { x1: number; y1: number; x2: number; y2: number };
export type PoseEvent = { step: string; start: number; end: number; best_score: number };
export type Comment = { t: number; pose: string | null; part?: string; status: string; message: string; target?: string | null; kind?: "coach" };
export type FrameResult = {
  type: "frame";
  frame: number;
  t: number;
  people: number;
  dancer: { box: Box; confidence: number; keypoints: number[][] } | null;
  evaluation: Evaluation | null;
  motion: number | null;
  current: { step: string | null; since: number | null; held_s: number | null };
  counts: Record<string, number>;
  new_events: PoseEvent[];
  new_comments: Comment[];
  image: { width: number; height: number } | null;
  latency_ms: { yolo: number | null; total: number };
  model?: string;
  source_time?: number | null;
  /** True when a saved keypoint adjustment replaced the model's keypoints. */
  adjusted?: boolean;
};
export type Recorded = {
  result: FrameResult;
  blob: Blob;
  /** The analysed video or picture (file name and size); null for the camera. */
  mediaKey: string | null;
  /** Seconds inside the video (0 for a picture); null for the camera. */
  sourceTime: number | null;
  /** The model's own dancer and evaluation, kept when the keypoints are adjusted by hand. */
  beforeAdjustment?: Pick<FrameResult, "dancer" | "evaluation">;
};

/** Identifies a file across sessions: the same video gives the same key. */
export const mediaKeyOf = (file: File) => `${file.name}|${file.size}`;
export type Vocabulary = {
  poses: Record<string, { family: string; description: string; targets: Record<string, string> }>;
  families: Record<string, string[]>;
  parts: string[];
};

export const STATUS_COLOR: Record<Status, string> = { ok: "#3ddc84", warn: "#ffb547", bad: "#ff5d6c", none: "#5b6680" };
const STEP_PALETTE = ["#4f8cff", "#3ddc84", "#ff9f5a", "#a78bfa", "#ff5d6c", "#5ee3e8", "#f5d547", "#ff7ac6", "#9be15d"];
export function stepColor(step: string | null | undefined, vocab?: Vocabulary | null): string {
  if (!step) return "#3a4560";
  const names = vocab ? Object.keys(vocab.poses) : [];
  const i = names.indexOf(step);
  const h = i >= 0 ? i : Array.from(step).reduce((a, c) => a + c.charCodeAt(0), 0);
  return STEP_PALETTE[h % STEP_PALETTE.length];
}

// COCO-17 edges with the body part they belong to (for colouring by feedback).
export const EDGES: [number, number, string][] = [
  [15, 13, "left_leg"], [13, 11, "left_leg"], [16, 14, "right_leg"], [14, 12, "right_leg"], [11, 12, "hips"],
  [5, 11, "torso"], [6, 12, "torso"], [5, 6, "shoulders"], [5, 7, "left_arm"], [7, 9, "left_arm"],
  [6, 8, "right_arm"], [8, 10, "right_arm"], [0, 1, "head"], [0, 2, "head"], [1, 3, "head"], [2, 4, "head"],
];
export const JOINT_NAMES = ["nose", "", "", "", "", "L shoulder", "R shoulder", "L elbow", "R elbow", "L wrist", "R wrist",
  "L hip", "R hip", "L knee", "R knee", "L ankle", "R ankle"];
export const VIS = 0.5;
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
