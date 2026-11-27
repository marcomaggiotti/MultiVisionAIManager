// What changed in each version (newest first). Every update bumps the version in
// package.json and manager/api/pyproject.toml and adds an entry here.
export type Release = { version: string; date: string; title: string; changes: string[] };

export const CHANGELOG: Release[] = [
  {
    version: "0.35.0", date: "2026-11-27", title: "🐱 A rounder cat that stays on the dancer",
    changes: [
      "The cat stays on the keypoints: YOLO's jitter is removed (a centred average over the frames around, so no lag), keypoints missed for under 0.5 s are filled in, and the preview follows the video between two analysed frames instead of jumping.",
      "It looks round: shaded tube limbs, a shaded sphere for the head and the paws, a shadow on the floor; the limbs of the far side are darker and behind the body, and the face turns with the head.",
      "Exported videos: the same cat; the text is in DejaVu Sans Bold, with the accents of the ballet terms (plié, relevé, développé).",
    ],
  },
  {
    version: "0.34.0", date: "2026-11-27", title: "🎤 Karaoke captions, always readable",
    changes: [
      "🎬 Preview and exported videos: the captions are a karaoke band at the bottom of the video, two lines tall, dark and opaque, with bold outlined text, readable on any picture.",
      "The words light up in yellow one after the other, from when the caption appears (2 s before the movement) to the end of the movement; the word to follow now is underlined.",
      "Long captions scroll up line by line, smoothly, so the current word is always in view; the band stays full on the last two lines.",
      "The exported MP4 draws the same band with the same timing as the preview.",
    ],
  },
  {
    version: "0.33.0", date: "2026-11-27", title: "🐱 A cartoon cat in the dancer's place",
    changes: [
      "🎬 Preview: 🦴 Skeleton or 🐱 Cat. The cat is drawn on the dancer's keypoints and moves with her: round tabby body, striped legs and arms, paws, ears, blinking eyes, whiskers, a tail that sways (faster while she moves); moving limbs glow in their colour.",
      "“hide the dancer” blurs her out behind the cat.",
      "Exported with the cat: <name>-cat.mp4 in the Library (captions and sound included).",
      "The studio's video list no longer shows the made videos (comparisons, annotated videos).",
    ],
  },
  {
    version: "0.32.0", date: "2026-11-27", title: "Preview with captions, exported to the library",
    changes: [
      "Live studio: the limb movements are now a 🎬 Preview (the button after Snapshot, Adjust keypoints, Note): the video in a large window, the moving limbs lit up.",
      "A caption at the bottom of the video announces each movement 2 s before it starts (adjustable) and stays until it ends; the labels under the video are gone.",
      "The captions are proposed from the movements found and can be rewritten or removed; the edits are saved with the video (↺ Propose again forgets them).",
      "⬇ Export to the library: an MP4 with the skeleton, the moving limbs, the captions and the video's sound (<name>-annotated.mp4).",
    ],
  },
  {
    version: "0.31.2", date: "2026-11-27", title: "Clicking a note stops on its frame",
    changes: [
      "Live studio: clicking a note pauses the player on the note's exact frame (the timeline, the panels and the keypoints show it); before, a replay going on moved past it at once.",
      "Analysis: clicking a note outside the time range shown loads the frames around it and selects the note's frame.",
    ],
  },
  {
    version: "0.31.1", date: "2026-11-27", title: "The sound panel moves to Compare",
    changes: [
      "🎵 Sound is now in Compare → Library videos: choose which compared video's sound (the reference by default: the teacher's explanations), extract and clean it, and hear the original or cleaned sound in time with the comparison (that video's offset included).",
      "The live studio no longer has the sound panel; the 🦵 Limb movements video plays the video's own sound.",
    ],
  },
  {
    version: "0.31.0", date: "2026-11-27", title: "Live studio: which limb is moving",
    changes: [
      "🦵 Limb movements (library videos): the video plays under the studio with the skeleton over it; each limb (arms, legs, head, torso, whole body) lights up in its colour while YOLO's keypoints show it moving.",
      "Every movement found is listed (limbs moving together are one moment): click it to play from 2 s before (adjustable), with a countdown, stopping after it; ▶ Play every movement chains them.",
      "One lane per limb shows when it moves; sensitivity for large or small movements; the panels above follow the video.",
      "Limbs are measured relative to the body, from smoothed keypoints, so travelling across the floor and YOLO's jitter are not taken for limbs moving.",
    ],
  },
  {
    version: "0.30.1", date: "2026-11-27", title: "Windows start script; modules downloaded when missing",
    changes: [
      "start.ps1 for Windows PowerShell (like start.sh): downloads the module repositories that are missing (e.g. the new modules/audio), then builds and starts everything. -Cpu, -Update, -Down.",
      "start.sh and start.ps1 align the submodule configuration first, so a module added by a pull is found.",
    ],
  },
  {
    version: "0.30.0", date: "2026-11-26", title: "Notes on frames; the video's sound, extracted and cleaned",
    changes: [
      "Live studio (library videos): 📝 Note (or N) writes a text note on the shown frame; the Notes panel lists them (click to go there) and the timeline marks them. Analysis shows and edits them too.",
      "🎵 Sound: extract the video's audio and clean it with the new audio module (audio_clean_service): its agent measures the recording, tries plans and keeps the best for the goal (speech, listening, archive), or choose the filters (de-clip, de-click, de-hum, high-pass, noise reduction, loudness).",
      "Pauses are never shortened, so the original or cleaned sound plays in time with the frames. The report shows the plan, the reasons, the measurements before / after and the spectrograms.",
      "New module: modules/audio (git submodule, Docker service “audio”, started when needed).",
    ],
  },
  {
    version: "0.29.0", date: "2026-11-26", title: "VLM agent systems; Compare: library videos only, camera asks again",
    changes: [
      "VLM → Agents: sequential agent systems drawn as a graph (agents as ellipses, tools as boxes; the active agent turns green while it runs). Each agent: instruction, model (local VLM and which of its models, or a cloud model), tools, sees the frames or not; it reads the earlier answers ({{describer_agent}}…).",
      "Templates: VLM auditor (describer → critic with tools → reviser) and Coach team (measure → explain → plan). Saved, run on a video, chosen frames or pictures.",
      "An agent without tools answers directly; an agent can use its own VLM model.",
      "Compare → Live: the videos are chosen from the library only (no file of this device).",
      "Camera refused: the message says why (refused, blocked for the site, not a secure page, missing, in use) and “↻ Ask again” asks once more; the live studio uses the same explanations.",
    ],
  },
  {
    version: "0.28.0", date: "2026-11-26", title: "VLM: pipelines of prompts, clearer prompt list",
    changes: [
      "VLM → Pipelines: steps asked one after the other, saved by name. Each step: a saved prompt or its own text, its VLM model, with or without the pictures; {{last}} and {{step1}}, {{step2}}… pass the answers on. Add, reorder, duplicate, remove steps; run on a video, chosen frames or pictures, step by step.",
      "VLM → Prompts: the library is a searchable list with the text of each prompt and ✎ edit, ⧉ duplicate, 🗑 delete buttons.",
      "Frames chosen in Video frames stay chosen in the other VLM tabs (“🖼 Chosen frames” input).",
    ],
  },
  {
    version: "0.27.0", date: "2026-11-26", title: "Compare library videos: reference and performances",
    changes: [
      "Compare → Library videos: tick the reference (the instruction video to follow, by default the oldest) and one or more performances among the analysed videos.",
      "The newest performance is shown with every other dancer's skeleton over it, the reference's in gold; each is aligned on the dancer's torso, and an offset per video lines up the starts.",
      "Match score with the reference for every performance: at each frame, on average, and as a chart over time (click to go there); left / right mirroring is detected.",
      "🎬 Make the comparison video: an MP4 of the newest performance with all the skeletons, names and scores, saved in the Library.",
    ],
  },
  {
    version: "0.26.1", date: "2026-11-26", title: "VLM: remove a chosen frame",
    changes: [
      "VLM → Video frames: each chosen frame in the strip next to the question has a ✕ to leave it out (the grid and the count follow).",
    ],
  },
  {
    version: "0.26.0", date: "2026-11-26", title: "VLM: ask about chosen frames of a video",
    changes: [
      "VLM → Video frames (the first tab): choose a library video, its analysed frames appear (time range, every frame or fewer); click one or several (shift-click for a span, up to 16).",
      "Choose the VLM model (loaded one, catalogue or any model id: loaded first) and a prompt (saved or written), then ask: the frames go to the VLM in time order and the answer shows with them.",
      "The model choice is the same as in the AI workflow builder; the call is in History.",
    ],
  },
  {
    version: "0.25.0", date: "2026-11-26", title: "Frame pictures in a database, ready for Azure",
    changes: [
      "The pictures of the analysed frames (and the analyses) are stored in a database (SQLite, pictures.sqlite3 in the manager's data) instead of files; analyses saved as files before are moved in at start.",
      "The same picture store has an Azure Blob Storage version: when Azure is connected, “python -m app.media.picture_store migrate --to azure” copies everything, then MANAGER_PICTURE_STORE=azure switches to it.",
      "Each analysis keeps its pictures under its own run, so a new analysis replaces the old one at once and the browser can cache the pictures.",
    ],
  },
  {
    version: "0.24.0", date: "2026-11-26", title: "Exact frame in the studio, same keypoints as Analysis",
    changes: [
      "Live studio player: the time (m:ss.cc, every frame has its own) and the frame number can be typed: Enter goes to that exact frame (“37.8”, “0:37,80” or “1:02.35” work).",
      "Keypoints corrected in the Analysis tab (or the YOLO tab) are shown in the live studio: coming back to it reloads the video's analysis at the same frame.",
      "Analysis → Video keypoints: “▶ Live studio” opens the selected frame in the studio, paused, with the same keypoints and every panel.",
    ],
  },
  {
    version: "0.23.3", date: "2026-11-25", title: "Timeline: slide with the mouse",
    changes: [
      "Live studio timeline: press on any track (poses, motion energy, leg elevation, knee angles) and slide: the playhead follows the mouse and the panels and keypoints show each frame passed (it keeps following outside the track until you release).",
    ],
  },
  {
    version: "0.23.2", date: "2026-11-25", title: "Analysis progress in the top bar",
    changes: [
      "The analysis of library videos shows at the top right of every page: “⏳ Analysing name 68 %” (+N when more wait), then “✓ name analysed · open ▶” for a moment, which opens it in the live studio. The pop-up window after an upload is gone.",
    ],
  },
  {
    version: "0.23.1", date: "2026-11-25", title: "Live studio: no Save button",
    changes: [
      "The Save button is gone: library videos are saved by their analysis, pictures when their analysis ends, and a camera session when you press ■ Stop (Sessions tab).",
    ],
  },
  {
    version: "0.23.0", date: "2026-11-25", title: "Videos are analysed when added to the library",
    changes: [
      "Adding a video to the library starts its analysis in the manager: every frame's keypoints, angles, movements and corrections (15 frames per second, at most 1500). A window shows the progress until it is done; each card shows its state; ↻ analyses again.",
      "The live studio no longer analyses videos: choosing a video (✓ = analysed) loads and plays its stored analysis at once. Correcting keypoints saves them in the analysis and the keypoint track straight away.",
      "Cut videos and videos already in the library are analysed the same way (an interrupted analysis restarts with the manager). Renaming a video keeps its keypoints and corrections.",
      "The camera stays live in the studio (■ Stop, Save); pictures are analysed in the studio and saved.",
    ],
  },
  {
    version: "0.22.1", date: "2026-11-25", title: "Live studio: is the video analysed?",
    changes: [
      "A line under the toolbar tells whether the chosen video is analysed: progress while it runs, then “✓ analysed: keypoints saved for N frames, available frame by frame in the Analysis tab” with “Open in Analysis →” (at the frame shown).",
      "The video list marks analysed videos with ✓.",
    ],
  },
  {
    version: "0.22.0", date: "2026-11-25", title: "The CLIP module is its own project",
    changes: [
      "The CLIP module moved, with its history, to github.com/marcomaggiotti/visual-semantic-engine: an independent web service with its own README (including how CLIP works), Docker Compose, tests and CI.",
      "modules/clip is now a git submodule (like YOLO and the VLM): ./start.sh clones it, ./start.sh --update updates it; the manager uses its API as before and nothing changes in the web interface.",
    ],
  },
  {
    version: "0.21.0", date: "2026-11-25", title: "Snapshot → the frame in Analysis",
    changes: [
      "Live studio: 📷 Snapshot (or S) on a frame of an analysed library video keeps the snapshot in the library and opens Analysis → Video keypoints at that frame (5 s of video around it), ready to adjust. Camera frames still open the snapshot dialog.",
      "Analysis: the selected frame can be opened in YOLO, CLIP or the VLM.",
      "Library → Snapshots: clicking a snapshot taken from a library video opens its frame in Analysis (🔍 shows the picture).",
    ],
  },
  {
    version: "0.20.0", date: "2026-11-25", title: "Live studio: choose a video, it is analysed and saved",
    changes: [
      "No Start button and no “📚 Library video” button: the toolbar lists the library's videos (added in the Library tab); choosing one analyses it whole, frame by frame, with a progress bar.",
      "At the end the session and every frame's keypoints are saved by themselves, and the video plays back with its analysis, ready to inspect and adjust; an adjusted frame replaces its saved keypoints.",
      "“↻ Analyse again” re-runs the analysis with new properties. ◉ Camera starts the camera at once (■ Stop, then Save); ▦ Pictures are analysed and saved the same way as a video.",
    ],
  },
  {
    version: "0.19.0", date: "2026-11-25", title: "Analysis: keypoints table view",
    changes: [
      "Analysis → Video keypoints: “☰ Table” shows one line per frame (small picture with its skeleton, time, movement) and the 17 keypoints (0 nose … 16 right ankle) as columns, with x and y in pixels; points not visible are faded.",
      "Click a line to open that frame below; click a column title to follow that keypoint in the trajectory chart. “▦ Pictures” returns to the thumbnails; the choice is remembered.",
    ],
  },
  {
    version: "0.18.1", date: "2026-11-25", title: "Analysis: keypoints on the large picture",
    changes: [
      "Analysis → Video keypoints: the skeleton of the large picture was stretched over the black side bars (portrait videos) and missed the joints; it is now scaled and centred like the picture, as in the thumbnails.",
    ],
  },
  {
    version: "0.18.0", date: "2026-11-25", title: "The VLM module is its own project",
    changes: [
      "The VLM module moved, with its history, to github.com/marcomaggiotti/vlm_hub_engine: an independent web service with its own README, Docker Compose, tests and CI.",
      "modules/vlm is now a git submodule (like YOLO): ./start.sh clones it, ./start.sh --update updates it; nothing changes in the web interface.",
    ],
  },
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
