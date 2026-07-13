#!/usr/bin/env bash
# Helmora Hub — full Pterodactyl Linux startup (custom ON = replaces panel default).
#
# Paste:
#   bash scripts/ptero-startup.sh
#
# First boot without files — set panel env then restart:
#   GIT_REPO=https://github.com/Helmora-AI/HelmoraHub.git
#   GIT_BRANCH=master   (optional)
set -euo pipefail

cd /home/container 2>/dev/null || true

log() { echo "[helmora] $*"; }
die() { echo "[helmora] ERROR: $*" >&2; exit 1; }

# --- bootstrap: clone if empty ---
if [[ ! -f package.json ]]; then
  if [[ -n "${GIT_REPO:-}" ]]; then
    BRANCH="${GIT_BRANCH:-master}"
    log "package.json missing — cloning ${GIT_REPO} (${BRANCH})…"
    if [[ -d .git ]]; then
      git fetch --all
      git checkout "${BRANCH}"
      git pull origin "${BRANCH}"
    else
      # Avoid clobbering unrelated panel files: clone into tmp then move
      rm -rf .helmora-clone
      git clone --depth 1 --branch "${BRANCH}" "${GIT_REPO}" .helmora-clone
      # Move contents (including hidden) into /home/container
      shopt -s dotglob nullglob
      mv .helmora-clone/* .
      shopt -u dotglob nullglob
      rm -rf .helmora-clone
    fi
  else
    die "No package.json in /home/container.
Upload Helmora Hub (File Manager / SFTP) OR set:
  GIT_REPO=https://github.com/Helmora-AI/HelmoraHub.git
  GIT_BRANCH=master
then restart."
  fi
fi

[[ -f package.json ]] || die "package.json still missing after bootstrap"

# --- sync ---
if [[ -d .git ]]; then
  log "git pull…"
  git pull || log "git pull failed (continuing with local tree)"
fi

if [[ -n "${NODE_PACKAGES:-}" ]]; then
  /usr/local/bin/npm install ${NODE_PACKAGES}
fi

if [[ -n "${UNNODE_PACKAGES:-}" ]]; then
  /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}
fi

log "npm install…"
if command -v /usr/local/bin/npm >/dev/null 2>&1; then
  NPM=/usr/local/bin/npm
  NODE=/usr/local/bin/node
else
  NPM=npm
  NODE=node
fi

# npm 12 blocks dependency install scripts unless allowScripts (better-sqlite3 needs native build).
export npm_config_ignore_scripts=false
if $NPM approve-scripts --help >/dev/null 2>&1; then
  $NPM approve-scripts better-sqlite3 --no-allow-scripts-pin >/dev/null 2>&1 \
    || $NPM approve-scripts better-sqlite3 >/dev/null 2>&1 \
    || true
fi

$NPM install --foreground-scripts

ensure_sqlite_binding() {
  find node_modules/better-sqlite3 -name 'better_sqlite3.node' 2>/dev/null | head -n 1
}

if [[ -z "$(ensure_sqlite_binding)" ]]; then
  log "better-sqlite3 .node missing — forcing rebuild…"
  if [[ -d node_modules/better-sqlite3 ]]; then
    (
      cd node_modules/better-sqlite3
      $NPM run install --foreground-scripts 2>/dev/null \
        || npx --yes prebuild-install \
        || node-gyp rebuild --release
    ) || $NPM rebuild better-sqlite3 --foreground-scripts || true
  fi
  if [[ -z "$(ensure_sqlite_binding)" ]]; then
    log "reinstalling better-sqlite3…"
    $NPM uninstall better-sqlite3 >/dev/null 2>&1 || true
    $NPM install better-sqlite3 --foreground-scripts
  fi
fi

[[ -n "$(ensure_sqlite_binding)" ]] || die "better-sqlite3 native binding still missing.
Panel image may lack build tools, or npm 12 blocked scripts.
Fix: ensure package.json has allowScripts.better-sqlite3=true, then wipe node_modules and restart."

# --- Helmora runtime env ---
export NODE_ENV="${NODE_ENV:-production}"
export DATA_DIR="${DATA_DIR:-/home/container/data}"
export HELMORA_PUBLIC="${HELMORA_PUBLIC:-1}"

if [[ -z "${PORT:-}" ]]; then
  if [[ -n "${SERVER_PORT:-}" ]]; then export PORT="${SERVER_PORT}"
  elif [[ -n "${P_SERVER_PORT:-}" ]]; then export PORT="${P_SERVER_PORT}"
  elif [[ -n "${SERVERPORT:-}" ]]; then export PORT="${SERVERPORT}"
  fi
fi

mkdir -p "${DATA_DIR}"

if [[ ! -f .env ]] && [[ -f .env.example ]]; then
  cp .env.example .env
  log "Created .env from .env.example"
fi

log "npm run build…"
$NPM run build

[[ -f scripts/ptero-start.mjs ]] || die "scripts/ptero-start.mjs missing — wrong tree?"
[[ -f dist/index.js ]] || die "dist/index.js missing after build"

log "starting (PORT=${PORT:-unset} DATA_DIR=${DATA_DIR})…"
exec $NODE scripts/ptero-start.mjs
