#!/usr/bin/env bash
# Start the MultiVision AI Manager.
#   ./start.sh          NVIDIA GPU
#   ./start.sh --cpu    CPU only
#   ./start.sh --update also pull the latest commits of the YOLO module repository
#   ./start.sh down     stop and remove the manager and the modules
#
# Starts the manager (web + API) and the modules (YOLO, CLIP, VLM: separate web
# services). The manager can then stop and relaunch each module.
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
  compose down
  exit 0
fi

# Modules kept in their own repositories (git submodules):
#   modules/yolo = https://github.com/marcomaggiotti/detect_image_engine
#   modules/vlm  = https://github.com/marcomaggiotti/vlm_hub_engine
for module in yolo vlm; do
  if [ ! -f "modules/$module/Dockerfile" ]; then
    echo "Cloning the $module module into modules/$module..."
    git submodule update --init --recursive "modules/$module"
  fi
  if $update; then
    echo "Updating modules/$module to the latest commit of its branch..."
    git submodule update --init --remote "modules/$module"
  fi
done

[ -f .env ] || cp .env.example .env
# Group that owns the Docker socket, so the manager may launch the modules.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID="$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock)"
  export DOCKER_GID
fi

echo "Building and starting the manager and the modules..."
compose up -d --build
echo
echo "MultiVision AI Manager: http://localhost:${WEB_PORT:-3000}"
echo "Phones/tablets on the same network: https://<this computer's IP>:${WEB_HTTPS_PORT:-3443}"
