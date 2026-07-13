#!/usr/bin/env bash
# Helmora Hub — full Pterodactyl Linux startup (replaces panel default when custom is ON).
#
# Paste into panel "Startup Command" (one line):
#   bash scripts/ptero-startup.sh
#
# Or paste the expanded one-liner from deploy/pterodactyl/STARTUP.md
set -euo pipefail

cd /home/container 2>/dev/null || cd "$(dirname "$0")/.." || true

# --- same stages as host Node egg (git → packages → npm install) ---
if [[ -d .git ]]; then
  echo "[helmora] git pull…"
  git pull
fi

if [[ -n "${NODE_PACKAGES:-}" ]]; then
  /usr/local/bin/npm install ${NODE_PACKAGES}
fi

if [[ -n "${UNNODE_PACKAGES:-}" ]]; then
  /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}
fi

if [[ -f /home/container/package.json ]]; then
  echo "[helmora] npm install…"
  /usr/local/bin/npm install
elif [[ -f package.json ]]; then
  echo "[helmora] npm install…"
  npm install
fi

# --- Helmora ---
export NODE_ENV="${NODE_ENV:-production}"
export DATA_DIR="${DATA_DIR:-/home/container/data}"
export HELMORA_PUBLIC="${HELMORA_PUBLIC:-1}"

if [[ -z "${PORT:-}" ]]; then
  if [[ -n "${SERVER_PORT:-}" ]]; then
    export PORT="${SERVER_PORT}"
  elif [[ -n "${P_SERVER_PORT:-}" ]]; then
    export PORT="${P_SERVER_PORT}"
  elif [[ -n "${SERVERPORT:-}" ]]; then
    export PORT="${SERVERPORT}"
  fi
fi

mkdir -p "${DATA_DIR}"

if [[ ! -f .env ]] && [[ -f .env.example ]]; then
  cp .env.example .env
  echo "[helmora] Created .env from .env.example"
fi

echo "[helmora] npm run build…"
if command -v /usr/local/bin/npm >/dev/null 2>&1; then
  /usr/local/bin/npm run build
  echo "[helmora] starting…"
  exec /usr/local/bin/node scripts/ptero-start.mjs
else
  npm run build
  echo "[helmora] starting…"
  exec node scripts/ptero-start.mjs
fi
