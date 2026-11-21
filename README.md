# MultiVision AI Manager

A hub that manages several computer-vision modules. **Every module is a separate web
service** (its own container, API and web page). The manager is the master: it
**launches and stops the modules** (from the dashboard, or automatically when a pipeline
or the web interface needs one), checks their health, forwards the web interface's calls
to them and **triggers** them in pipelines. The first use case is **movement in sport**, starting
with **classical ballet**, on **single pictures or sequences of pictures** (no video yet).

![Live studio](docs/live-studio.png)

## Live studio: real-time ballet feedback

The home page of the web interface. Start the **camera** (or a **video file**, or a
**sequence of pictures**): every frame goes to YOLO pose through the manager, and within
milliseconds the studio shows:

| Panel | What it shows |
| --- | --- |
| **A · Camera** | The analysed picture with the skeleton, each limb coloured by its correction (optional box, knee angles, mirror view) |
| **B · Body-part feedback** | The dancer's own skeleton as a map: green = good, amber = adjust, red = correct, with the key angles |
| **C · Skeletal tracking** | The 17 tracked joints, named, on a perspective floor |
| **D · Pose recognition** | The ballet pose being held and for how long, this frame's candidates, the pose's description and targets, and every correction with its target |
| **Timeline** | Held poses, motion energy, leg elevation and knee angles over the session; click or replay to review any moment |
| **Left** | Session, the ballet vocabulary with how many times each pose was performed, body-part status |
| **Right** | Detected poses (count and time held), properties (frame rate, thresholds, frames to hold a pose, smoothing, resolution), the feedback log |

**Recognised poses** (rules on joint angles, `manager/api/app/ballet.py`): arabesque,
attitude, développé, grand battement, passé, grand jeté, plié (demi / grand), second
position, first / fifth position. When none fits, the studio says so (a transition).

**Feedback per body part**, against the pose's targets: working and supporting knee
straight (≥ 170°), working-leg height (90° arabesque, 110° grand battement), attitude
knee 90-130°, split ≥ 160° in grand jeté, even knees in plié, torso vertical, back lifted
in arabesque, shoulders and hips level, the whole body in the picture. Corrections that
persist are written to the feedback log, with the time, so you can jump back to them.

- Keypoints are smoothed and a pose must hold for a few frames before it is recognised and
  counted (both adjustable), so the feedback does not flicker.
- Frames go over a WebSocket (`/api/live/ws`); the next one leaves when the previous answer
  arrives, so the frame rate follows the GPU (15+ fps with YOLO11n-pose).
- **AI coach** sends the shown frame through the full pipeline (CLIP + VLM) for a
  teacher-style comment. **Save** stores the session (counts, events, comments, angle
  series) in the manager.
- **Sessions** tab: every saved session (search by title or pose), with poses performed and
  time held, the most frequent corrections, the held-pose timeline, angle and motion charts
  and the feedback log; rename, download as JSON or delete. Sessions are stored in the
  manager's SQLite database (`manager.sqlite3` in the `manager-data` volume); API:
  `GET/PATCH/DELETE /api/live/sessions[/<id>]`.
- Angles are measured in the picture (2-D): film from the side for arabesque, attitude
  and jumps, from the front for positions and plié.

```mermaid
flowchart TB
  UI["01 · Web interface (React)<br/>localhost:3000"] --> API
  API["02 · Manager API (FastAPI)<br/>registry · health · proxy · pipelines · history"]
  API -->|/api/modules/yolo/...| YOLO["YOLO module<br/>detection & pose · lab"]
  API -->|/api/modules/clip/...| CLIP["CLIP module<br/>embeddings · zero-shot · retrieval"]
  API -->|/api/modules/vlm/...| VLM["VLM module<br/>small vision-language models"]
  API --> R["05 · Context & reasoning<br/>joint angles · ballet cues · motion · fusion"]
  YOLO & CLIP & VLM --> GPU[(GPU)]
  API --> DB[(SQLite history)]
  CLIP & VLM --> HF[(Hugging Face cache)]
```

| Layer (from the design) | Implemented as |
| --- | --- |
| 01 User interface | `manager/web` (React + Vite): live studio, analysis, module studios; plus a standalone page in every module (`/ui/`) |
| 02 API & application | `manager/api` (FastAPI): module registry, health, reverse proxy, pipeline, history |
| 03 Image processing | Upload of one picture or an ordered sequence, EXIF orientation, per-model resizing, dancer crops |
| 04 AI perception | YOLO (detection + 17-keypoint pose), CLIP, VLM modules |
| 05 Context & reasoning | `manager/api/app/ballet.py` + `live.py` (real-time recognition and feedback), `pose.py` + `pipeline.py`: joint angles, ballet pose cues, motion across frames, a VLM prompt grounded in those measurements, evidence fusion |
| 06 Output & knowledge | Structured results, analysis history with the pictures |
| 07 Data & infrastructure | Docker Compose, a volume per module, shared Hugging Face cache, SQLite (PostgreSQL / vector DB later) |

## Modules

Every module is an independent web service that serves `GET /health`, `GET /v1/info`
(name, model, device, capabilities) and its own web page at `/ui/`.

### How the manager launches and triggers them

The registry [`modules.json`](modules.json) lists each module: where its web service
answers, its source repository, and how the manager launches it:

```json
{"name": "yolo", "url": "http://yolo:8000",
 "repository": "https://github.com/marcomaggiotti/detect_image_engine",
 "launcher": {"type": "docker", "service": "yolo"},
 "autostart": true, "idle_stop_minutes": 0, "start_timeout": 300}
```

| Launcher | What the manager does |
| --- | --- |
| `docker` | Starts/stops the module's container (created by `start.sh`) through the Docker socket |
| `process` | Runs the module as a local process ([`modules.local.json`](modules.local.json), development without Docker) |
| `none` | Only talks to a service started elsewhere |

- **On demand**: with `autostart`, a module is launched the first time a pipeline or the
  web interface calls it, and the call waits until it answers (up to `start_timeout`).
- **By hand**: Start / Stop / Restart / Logs on each dashboard card, or the API:
  `POST /api/manage/<name>/start|stop|restart`, `GET /api/manage/<name>/logs`.
- **Idle stop**: `idle_stop_minutes` stops a module again after that long without calls,
  freeing GPU memory (the VLM: 30 minutes by default).
- **Triggering**: the web interface reaches each module at `/api/modules/<name>/...`;
  the ballet pipeline (`POST /api/analyze`) calls YOLO, CLIP and the VLM in turn.

To add a module: give it `/health`, `/v1/info` and a page, add a service with
`profiles: [modules]` to `docker-compose.yml`, and an entry to `modules.json`.

### YOLO: detection & pose

Lives in its own repository, [detect_image_engine](https://github.com/marcomaggiotti/detect_image_engine)
(the lab is on branch `claude/serene-dirac-srols1` until it is merged; after merging, set `branch = main` in `.gitmodules` and run `./start.sh --update`).
It is cloned automatically into `modules/yolo` (git submodule).

| Topic | Where to customise it in the UI (YOLO page) |
| --- | --- |
| IoU thresholds, confidence, input size, FP16 | *Inference & thresholds* (applied live) |
| Bounding-box regression, classification / objectness, DFL, pose losses | *Training → Losses* (gains) |
| Class imbalance | *Datasets* (class statistics, suggested weights), *Training → Losses* (focal loss, per-class weights), *Training → Class imbalance* (repeat-factor sampling) |
| Assignment strategies | *Training → Assignment* (Task-Aligned Assigner top-k / alpha / beta; RT-DETR Hungarian matcher costs) |
| Transfer learning, fine-tuning | *Training → Transfer learning* (base model, pretrained vs scratch, frozen layers, optimiser, LR schedule), continue from a previous run |
| Dataset annotation | *Datasets & annotation* (draw boxes, pre-label with the active model, import/export YOLO zip) |
| Augmentation | *Training → Augmentation* (presets incl. `ballet-studio`, every parameter) |
| Custom YOLO detector | *Models*: serve pretrained, fine-tuned (`job:<id>`) or exported weights |
| Robustness | *Robustness*: 11 perturbations × severity, share of detections kept |
| Latency optimisation | *Latency*: benchmark per input size and FP32/FP16; export to ONNX / TensorRT / OpenVINO |

### CLIP (`modules/clip`)

| Topic | Where |
| --- | --- |
| Dual encoders, image and text representations | *Model*: both towers (patch size, tokens, layers, parameters), CLIP and SigLIP checkpoints |
| Embedding spaces | *Embedding space*: 2-D PCA map of pictures and texts, modality-gap metrics |
| Contrastive learning, temperature scaling, cosine similarity | *Similarity*: cosine matrix and softmax in both directions with an adjustable temperature |
| Zero-shot classification | *Zero-shot & prompts*: ballet steps/positions, prompt ensembles, softmax vs sigmoid |
| Prompt sensitivity | Per-template probabilities and agreement; dataset-level accuracy per template; tokenizer view |
| Semantic retrieval | *Retrieval*: galleries, search by text or by picture |
| Linear probing | *Fine-tuning*: probe on frozen embeddings, compared with zero-shot, confusion matrix |
| Fine-tuning, hard negatives, domain adaptation | *Fine-tuning*: contrastive training with layer-unfreezing strategies, fixed or learnable temperature, hard-negative weighting (β) |

### VLM (`modules/vlm`)

| Topic | Where |
| --- | --- |
| Different VLMs, smaller first | *Models*: SmolVLM-256M (~1 GB) → SmolVLM-500M → LLaVA-OneVision-0.5B → InternVL3-1B → Qwen2-VL-2B → SmolVLM2-2.2B → Qwen2.5-VL-3B, any other Hugging Face id; 8/4-bit loading |
| Image encoders, cross-attention, multimodal alignment | *Models → Architecture*: image encoder → connector → language model, fusion type, parameter split |
| Tokenization | *Tokens & attention*: the templated prompt, image tokens per tile, special tokens |
| Attention | *Tokens & attention*: attention mass on image / prompt / answer per layer, layers × heads, heat map on the picture |
| Decoding | *Ask* (all parameters, per-token probabilities and alternatives), *Decoding comparison* (greedy / beam / sampling side by side) |
| Instruction tuning | *Instruction data* + *Instruction tuning*: LoRA / QLoRA, loss on the response only, optional connector training |
| Evaluation | *Evaluation*: exact match, contains, token F1, ROUGE-L, ballet-vocabulary recall, latency |

## Ballet analysis pipeline

*Ballet analysis* page, or `POST /api/analyze` with one or more pictures (in order):

1. **YOLO pose** finds the dancer (largest person) and 17 keypoints.
2. **Pose geometry** measures knee and elbow angles, leg and arm elevation, leg spread and
   torso tilt, and derives cues (e.g. *right leg extended behind at 95°, straight →
   arabesque*; *foot at the standing knee → passé / pirouette*). For a sequence it adds
   per-frame curves, joint motion and the peak leg elevation.
3. **CLIP** ranks ballet steps on the dancer's crop (plain-English descriptions of the
   French terms help).
4. **VLM** answers the question with the pictures *and* the measurements in its prompt.
5. **Fusion** ranks candidate steps with the evidence from each source.

The angles are 2-D, as seen by the camera, so the cues are hints, not measurements.

## Run it

Requirements: Docker with Compose v2.24+. For the GPU: an NVIDIA driver and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/).

```bash
git clone --recursive https://github.com/marcomaggiotti/MultiVisionAIManager
cd MultiVisionAIManager
docker compose up -d --build        # or ./start.sh (also clones modules/yolo) · ./start.sh --cpu
```

`docker compose up` builds and starts the manager and the three modules. From then on the
manager stops and relaunches each module (dashboard buttons, automatically when it is
needed, idle stop for the VLM). The YOLO module is the
[detect_image_engine](https://github.com/marcomaggiotti/detect_image_engine) repository,
included as a git submodule in `modules/yolo` (`--recursive` clones it; otherwise run
`git submodule update --init` once, or use `./start.sh`, which does it).

### From a phone or tablet on the same network

- Open **https://&lt;this computer's IP&gt;:3443** (find the IP with `ipconfig` on Windows,
  `ip addr` / `ifconfig` on Linux and macOS).
- The certificate is self-signed, so the browser warns once: choose *Advanced → Proceed*.
  HTTPS is needed because phones only allow camera access on secure pages; plain
  `http://<ip>:3000` works too, but without the camera.
- If the page does not open, allow ports 3000 and 3443 in the computer's firewall (Windows:
  *Windows Defender Firewall → Inbound rules*, or accept the prompt Docker Desktop shows).
- Optional: put the computer's IP in `.env` as `CERT_HOSTS=192.168.1.20` before the first
  start, to write it into the certificate.

Open http://localhost:3000. Once launched, the modules are also reachable directly:
YOLO http://localhost:8001/ui/, CLIP http://localhost:8002/ui/, VLM http://localhost:8003/ui/
(each with `/docs`). The first start downloads the models (YOLO weights are baked into the
image; CLIP and VLM go to the shared `hf-cache` volume).

No NVIDIA GPU:

```bash
./start.sh --cpu      # = docker compose -f docker-compose.yml -f docker-compose.cpu.yml up --build
```

**GPU memory.** YOLO11n-pose (~0.3 GB), CLIP ViT-B/16 in fp16 (~0.3 GB) and SmolVLM-256M
(~1 GB) fit together on a 4 GB GPU. For 2-3B VLMs use `VLM_QUANTIZATION=4bit`, and unload
the VLM (*VLM → Models → Unload*) before long YOLO or CLIP training on small GPUs.

### Development without Docker

The manager launches the modules as local processes with `modules.local.json`:

```bash
git submodule update --init modules/yolo
pip install -e "modules/yolo[ultralytics]" -e modules/clip -e modules/vlm
cd manager/api && pip install -e ".[dev]" && MANAGER_REGISTRY=../../modules.local.json uvicorn app.main:app --port 8080
cd manager/web && npm install && npm run dev      # http://localhost:5173
```

Tests: `pytest` in `manager/api`, `modules/clip`, `modules/vlm` and `modules/yolo`.
The CLIP and VLM suites build tiny random models offline, so they exercise the real
`transformers` / `peft` code paths without downloads.

## Repository layout

```
docker-compose.yml          GPU stack            docker-compose.cpu.yml   CPU override
modules.json                module registry (Docker)   modules.local.json   same, local processes
start.sh                    clone the YOLO module, build, create the modules, start the manager
manager/api/                hub: main.py (routes, proxy), registry.py + launchers.py (launching), pipeline.py, pose.py
manager/web/                React app: pages/LiveStudio + live/ (panels, timeline, session hook), Analyze, Dashboard (modules), studios
modules/clip/               CLIP module: engine.py, analysis.py, gallery.py, training.py, static/ (own page)
modules/vlm/                VLM module: engine.py, training.py (LoRA, evaluation), metrics.py, static/
modules/yolo/               YOLO module = detect_image_engine (git submodule)
```

## Next steps

- Video on the server side (today the browser samples video and camera frames and sends
  pictures); multi-dancer tracking; 3-D pose (depth or two cameras) for true angles.
- Knowledge layer: PostgreSQL for results, a vector database for CLIP embeddings, RAG
  over a ballet syllabus for the reasoning layer.
- Authentication and job queues (Redis) when more than one person uses it.
- Keypoint annotation in the YOLO annotator (today pose labels come from pre-labelling).
