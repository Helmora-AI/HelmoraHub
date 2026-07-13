#!/usr/bin/env node
/**
 * Universal start wrapper for Pterodactyl / panels with a fixed start command.
 * Maps SERVER_PORT → PORT, ensures data dir, then runs dist/index.js
 *
 * Panel start command examples:
 *   bash scripts/ptero-startup.sh
 *   node scripts/ptero-start.mjs
 *   npm start
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error('[helmora] dist/index.js missing. Run: npm run build');
  process.exit(1);
}

if (!process.env.PORT) {
  const panelPort =
    process.env.SERVER_PORT || process.env.P_SERVER_PORT || process.env.SERVERPORT;
  if (panelPort) process.env.PORT = String(panelPort);
}

if (!process.env.HOST && !process.env.HELMORA_PUBLIC && !process.env.CTRLHUB_PUBLIC) {
  // Panels allocate a public port — bind all interfaces by default
  process.env.HELMORA_PUBLIC = '1';
}

const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
