#!/usr/bin/env bash
set -euo pipefail

# agentCast MacBook Local Watcher
# Polls origin/main every 5 seconds; whenever new commits arrive from the cloud VM,
# pulls and rebuilds dist/chrome-mv3 locally, triggering Chrome's built-in dev-reloader automatically.

INTERVAL="${1:-5}"
echo "[agentCast] Watching origin/main every ${INTERVAL}s for cloud updates..."
echo "[agentCast] Load unpacked extension once in Chrome from: $(pwd)/dist/chrome-mv3"

if [ ! -d "dist/chrome-mv3" ]; then
  pnpm build
fi

while true; do
  git fetch origin main --quiet || true
  LOCAL_SHA="$(git rev-parse HEAD)"
  REMOTE_SHA="$(git rev-parse origin/main)"
  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    echo "[agentCast] New commit detected (${REMOTE_SHA:0:7}). Pulling & building..."
    git pull --ff-only origin main
    pnpm install --frozen-lockfile || pnpm install
    pnpm build
    echo "[agentCast] Updated! Chrome extension will reload automatically."
  fi
  sleep "$INTERVAL"
done
