#!/usr/bin/env bash
# Install / update helper for Pterodactyl install script or bare VPS.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Helmora Hub requires Node.js 20+. Found: $(node -v 2>/dev/null || echo none)"
  exit 1
fi

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# DevDependencies needed to compile TypeScript on the server
npm install --no-save typescript @types/node @types/express @types/cors @types/better-sqlite3
npm run build
npm prune --omit=dev

mkdir -p data
echo "Helmora Hub install complete. Start with: npm start   (or node scripts/ptero-start.mjs)"
