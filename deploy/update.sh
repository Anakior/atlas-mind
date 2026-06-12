#!/usr/bin/env bash
# Update an Atlas Mind instance deployed on Fly.io: pull the latest ENGINE
# version, rebuild the image and redeploy it. The CONTENT (cloned at boot from
# your repo) and the VOLUME (.atlas: accounts, tokens, 2FA, shares) are
# PRESERVED — a deployment only touches the engine code.
#
#   Usage: deploy/update.sh <fly-app-name>
#   e.g.:  deploy/update.sh my-kb-app
#
# That's all. No flags to remember; the config lives in deploy/fly.toml.
set -euo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
  echo "Usage: deploy/update.sh <fly-app-name>   (e.g. deploy/update.sh my-kb-app)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Pulling the latest engine version…"
git pull --ff-only || echo "  (pull skipped: no remote, or already up to date)"

echo "→ Deploying to '$APP' (content + volume preserved)…"
fly deploy -a "$APP" -c deploy/fly.toml --dockerfile deploy/Dockerfile

echo "✓ '$APP' is up to date."
