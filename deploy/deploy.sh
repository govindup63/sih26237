#!/usr/bin/env bash
# Sync source to the VM and rebuild only this stack. Never touches other containers.
set -euo pipefail

HOST="${SIH_HOST:-ubuntu@blankpoint.club}"
REMOTE="${SIH_REMOTE_DIR:-/home/ubuntu/sih26237}"
LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> syncing to ${HOST}:${REMOTE}"
ssh "$HOST" "mkdir -p '${REMOTE}'"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude web \
  "${LOCAL}/server" "${LOCAL}/deploy" "${HOST}:${REMOTE}/"

echo "==> building and starting"
ssh "$HOST" "cd '${REMOTE}/deploy' && docker compose up -d --build"

echo "==> health"
ssh "$HOST" "curl -fsS http://127.0.0.1:8090/api/health" && echo
echo "==> other stacks still up"
ssh "$HOST" "docker ps --format '{{.Names}}' | sort | tr '\n' ' '" && echo
