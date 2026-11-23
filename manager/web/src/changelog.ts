// What changed in each version (newest first). Every update bumps the version in
// package.json and manager/api/pyproject.toml and adds an entry here.
export type Release = { version: string; date: string; title: string; changes: string[] };

export const CHANGELOG: Release[] = [
  {
    version: "0.12.0", date: "2026-11-23", title: "Snapshot library",
    changes: [
      "Every snapshot taken in the live studio is saved in the library (the clean frame, with its video, time, movement and corrections).",
      "Library → 📷 Snapshots: view, annotate, download, delete, open in YOLO, CLIP or VLM.",
      "YOLO, CLIP and VLM tabs (and the VLM / Admin “Pictures” input): 📷 From snapshots to choose one or several.",
    ],
  },
  {
    version: "0.11.0", date: "2026-11-23", title: "YOLO hyperparameter search, version display",
    changes: [
      "YOLO → Tuning (search): grid or random search over training hyperparameters (learning rate, frozen layers, augmentation, loss gains…), short trials ranked on mAP, then serve the best or train it fully.",
      "The version is shown in the top bar; click it for what's new. A warning appears when the page and the server are not the same version (rebuild, or reload the page).",
      "Snapshots sent to YOLO, CLIP and VLM are always the clean frame (the live skeleton was drawn into the picture and showed twice).",
      "Adjusted keypoints are labelled “✎ adjusted” in the YOLO picture.",
    ],
  },
  {
    version: "0.10.0", date: "2026-11-23", title: "Admin: AI workflow builder, LangChain agents",
    changes: ["Graphic AI workflow builder across YOLO, ballet rules, CLIP, VLM and agents, run by LangGraph.", "LangChain agents with the manager's abilities as tools (Agents tab)."],
  },
  {
    version: "0.9.0", date: "2026-11-23", title: "Video library and VLM tools",
    changes: ["Library tab: upload, watch, cut, annotate videos.", "VLM: describe a video, prompt library (compare, chain), decision workflows."],
  },
  {
    version: "0.8.0", date: "2026-11-22", title: "Compare",
    changes: ["Dance along with a reference video (camera) or compare two videos: joint angles, green / yellow / red, live match score."],
  },
  {
    version: "0.7.0", date: "2026-11-22", title: "Cut videos, keypoints in the YOLO tab",
    changes: ["Cut a part of a video into a new file.", "Adjust or place keypoints in the YOLO tab."],
  },
  {
    version: "0.6.0", date: "2026-11-22", title: "Keypoint adjustments",
    changes: ["Drag misplaced keypoints; saved per video moment and reused.", "The live session survives tab changes."],
  },
  {
    version: "0.5.0", date: "2026-11-22", title: "Player and snapshots",
    changes: ["Play / pause, ±1-3 s, frame steps, speed.", "Snapshots shared with YOLO, CLIP, VLM; keypoint values and zoom in the YOLO tab."],
  },
  {
    version: "0.4.0", date: "2026-11-22", title: "Readable code",
    changes: ["Manager and modules refactored for clarity; README architecture diagram and CLIP explanation."],
  },
  {
    version: "0.3.0", date: "2026-11-21", title: "Phones and sessions",
    changes: ["HTTPS for phone cameras.", "Sessions tab."],
  },
  {
    version: "0.2.0", date: "2026-11-21", title: "Live studio",
    changes: ["Real-time ballet pose recognition and body-part feedback."],
  },
  {
    version: "0.1.0", date: "2026-11-21", title: "First version",
    changes: ["Manager hub with YOLO, CLIP and VLM modules in Docker."],
  },
];
