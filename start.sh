#!/usr/bin/env bash
# Start the MultiVision AI Manager.
#   ./start.sh          NVIDIA GPU
#   ./start.sh --cpu    CPU only
#   ./start.sh --update also pull the latest commits of the modules' repositories
# Any other arguments are passed to "docker compose up" (e.g. -d).
set -euo pipefail
cd "$(dirname "$0")"

files=(-f docker-compose.yml)
update=false
args=()
for a in "$@"; do
  case "$a" in
    --cpu) files+=(-f docker-compose.cpu.yml) ;;
    --update) update=true ;;
    *) args+=("$a") ;;
  esac
done

# The YOLO module is https://github.com/marcomaggiotti/detect_image_engine, a git
# submodule in modules/yolo: clone it if it is missing.
if [ ! -f modules/yolo/Dockerfile ]; then
  echo "Cloning the YOLO module (detect_image_engine) into modules/yolo..."
  git submodule update --init --recursive modules/yolo
fi
if $update; then
  echo "Updating modules/yolo to the latest commit of its branch..."
  git submodule update --init --remote modules/yolo
fi

[ -f .env ] || cp .env.example .env
exec docker compose "${files[@]}" up --build "${args[@]}"
