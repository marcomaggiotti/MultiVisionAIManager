#!/usr/bin/env bash
# Start the MultiVision AI Manager.
#   ./start.sh          NVIDIA GPU
#   ./start.sh --cpu    CPU only
#   ./start.sh --update also pull the latest commits of the YOLO module repository
#   ./start.sh down     stop and remove the manager and the modules
#
# The manager (web + API) is started. Each module (YOLO, CLIP, VLM) is a separate
# web service: its container is built and created here, and the manager launches it
# when it is needed or when you press Start on the dashboard.
set -euo pipefail
cd "$(dirname "$0")"

files=(-f docker-compose.yml)
update=false
action=up
for a in "$@"; do
  case "$a" in
    --cpu) files+=(-f docker-compose.cpu.yml) ;;
    --update) update=true ;;
    down) action=down ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
compose() { docker compose "${files[@]}" "$@"; }

if [ "$action" = down ]; then
  compose --profile modules down
  exit 0
fi

# YOLO module = https://github.com/marcomaggiotti/detect_image_engine, cloned into modules/yolo.
if [ ! -f modules/yolo/Dockerfile ]; then
  echo "Cloning the YOLO module (detect_image_engine) into modules/yolo..."
  git submodule update --init --recursive modules/yolo
fi
if $update; then
  echo "Updating modules/yolo to the latest commit of its branch..."
  git submodule update --init --remote modules/yolo
fi

[ -f .env ] || cp .env.example .env
# Group that owns the Docker socket, so the manager may launch the modules.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID="$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock)"
  export DOCKER_GID
fi

echo "Building and creating the module containers (yolo, clip, vlm)..."
compose --profile modules build
compose --profile modules create yolo clip vlm
echo "Starting the manager..."
compose up -d --build web manager-api
echo
echo "MultiVision AI Manager: http://localhost:${WEB_PORT:-3000}"
echo "Modules are launched by the manager when needed (or from the dashboard)."
