// What changed in each version (newest first). Every update bumps the version in
// package.json and manager/api/pyproject.toml and adds an entry here.
export type Release = { version: string; date: string; title: string; changes: string[] };

export const CHANGELOG: Release[] = [
  {
    version: "0.17.0", date: "2026-11-24", title: "AI workflow builder: a VLM model and a prompt per node",
    changes: [
      "Each “Ask the VLM” node chooses its VLM model: the loaded one, one of the VLM module's catalogue, or any model id. The manager loads it just before the node asks (and keeps it for the next node); the switch appears in History.",
      "The palette's Language group lists your saved prompts: one click adds a VLM node using that prompt.",
      "“＋ New prompt” writes and saves a prompt (also in VLM → Prompts) and adds it as a node, without leaving the builder.",
      "Nodes show their model on the canvas.",
    ],
  },
  {
    version: "0.16.0", date: "2026-11-24", title: "History of YOLO, CLIP and VLM use",
    changes: [
      "New History tab: every call to YOLO, CLIP and the VLM made through the manager (module tabs, Analysis, VLM tools, workflows, agents) with time, source, status, latency and a short summary of the result.",
      "Statistics per module (calls, errors, average time) and per source; filter by module, source, period and text.",
      "Open a call to see its picture (with detections), prompt, answer and settings; use the picture again in YOLO, CLIP or the VLM.",
    ],
  },
  {
    version: "0.15.0", date: "2026-11-24", title: "Adjust keypoints in Analysis",
    changes: [
      "Analysis → Video keypoints: “✎ Adjust keypoints” on the selected frame (or “Place keypoints” when no dancer was found): drag the points, save; they replace the frame's keypoints (marked ✎ adjusted) and the movement is recognised again.",
      "The correction is also kept as a keypoint adjustment of that moment: analysing the video again in the live studio uses it.",
    ],
  },
  {
    version: "0.14.0", date: "2026-11-24", title: "Video keypoints in Analysis, choose the studio's panels",
    changes: [
      "Save in the live studio also stores each analysed frame's keypoints with the library video (at its time in the video); analysing again replaces the frames of the part analysed.",
      "Analysis → Video keypoints: choose a video and a time range (e.g. 10 to 20 s): every saved frame as a thumbnail with its skeleton; click one (or ← / →) to see it large with its 17 keypoints; trajectory chart and CSV of the range.",
      "Live studio panels A-D: choose what each one shows (camera, body-part feedback, skeletal tracking, pose recognition, key positions, joint angles, motion energy, leg elevation, knee angles, arm elevation); charts follow the shown frame; the choice is remembered.",
    ],
  },
  {
    version: "0.13.0", date: "2026-11-24", title: "Live studio: keypoints in real time, per-frame collection",
    changes: [
      "Right panel “Keypoints · live”: the 17 keypoints (x, y in pixels, visibility) of the shown frame, updated as the video plays; hover rings a point in panel A, click follows it.",
      "“Keypoints per frame” under the timeline: every analysed frame's keypoints, a trajectory chart (x, y over the frames) of the followed keypoint, a frame table (click to go there), CSV and JSON download.",
      "Saved sessions now include each frame's keypoints and video time.",
    ],
  },
  {
    version: "0.12.3", date: "2026-11-24", title: "Live studio: videos from the library only",
    changes: ["The live studio's “Video file” upload is replaced by “📚 Library video”: choose a library video (or add one to the library from the picker)."],
  },
  {
    version: "0.12.2", date: "2026-11-23", title: "Fix: CLIP and VLM models load again",
    changes: [
      "CLIP and VLM images now use PyTorch 2.8 (CUDA 12.6): recent transformers refused the old PyTorch 2.5 (“AutoModel requires PyTorch >= 2.6”).",
      "RTX 50-series GPUs: set TORCH_BASE_IMAGE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime in .env.",
    ],
  },
  {
    version: "0.12.1", date: "2026-11-23", title: "Fix: Compare in Docker",
    changes: ["Compare could not connect in the Docker setup (“cannot reach the manager's compare endpoint”): the web server now forwards every WebSocket (live studio and Compare)."],
  },
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
