import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const GITHUB_BASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download';

const PLATFORM_MAP: Record<string, Record<string, string>> = {
  darwin: {
    x64: 'cloudflared-darwin-amd64.tgz',
    arm64: 'cloudflared-darwin-arm64.tgz',
  },
  win32: {
    x64: 'cloudflared-windows-amd64.exe',
    ia32: 'cloudflared-windows-386.exe',
    arm64: 'cloudflared-windows-amd64.exe',
  },
  linux: {
    x64: 'cloudflared-linux-amd64',
    arm64: 'cloudflared-linux-arm64',
  },
};

export type DownloadStatus = {
  downloading: boolean;
  progress: number;
};

const dlState: DownloadStatus = { downloading: false, progress: 0 };

export function getCloudflaredDownloadStatus(): DownloadStatus {
  return { ...dlState };
}

export function cloudflaredBinDir(dataDir: string): string {
  return path.join(dataDir, 'bin');
}

export function cloudflaredBinPath(dataDir: string): string {
  const name = os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return path.join(cloudflaredBinDir(dataDir), name);
}

function downloadUrl(): string {
  const platform = os.platform();
  const arch = os.arch();
  const mapping = PLATFORM_MAP[platform];
  if (!mapping) throw new Error(`Unsupported platform for cloudflared: ${platform}`);
  const file = mapping[arch] || Object.values(mapping)[0];
  return `${GITHUB_BASE}/${file}`;
}

function httpsGet(url: string): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          httpsGet(res.headers.location).then(resolve).catch(reject);
          return;
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await httpsGet(url);
  if (res.statusCode !== 200) {
    throw new Error(`cloudflared download failed: HTTP ${res.statusCode}`);
  }
  const total = Number(res.headers['content-length'] || 0);
  let received = 0;
  dlState.downloading = true;
  dlState.progress = 0;
  res.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) dlState.progress = Math.round((received / total) * 100);
  });
  await pipeline(res, createWriteStream(dest));
  dlState.downloading = false;
  dlState.progress = 100;
}

function isValidBinary(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const size = fs.statSync(filePath).size;
    if (size < 1024 * 1024) return false;
    execFileSync(filePath, ['--version'], {
      timeout: 10_000,
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Ensure cloudflared exists under data/bin (download from GitHub if needed). */
export async function ensureCloudflared(dataDir: string): Promise<string> {
  const binDir = cloudflaredBinDir(dataDir);
  const binPath = cloudflaredBinPath(dataDir);
  fs.mkdirSync(binDir, { recursive: true });

  // Prefer PATH cloudflared if present and working
  try {
    execFileSync('cloudflared', ['--version'], {
      timeout: 10_000,
      stdio: 'ignore',
      windowsHide: true,
    });
    return 'cloudflared';
  } catch {
    // fall through to bundled binary
  }

  if (isValidBinary(binPath)) return binPath;

  const url = downloadUrl();
  const tmp = path.join(binDir, `download-${Date.now()}`);
  console.log(`[tunnel] downloading cloudflared from ${url}`);
  await downloadToFile(url, tmp);

  const platform = os.platform();
  if (url.endsWith('.tgz')) {
    const tar = await import('node:child_process');
    tar.execFileSync('tar', ['-xzf', tmp, '-C', binDir], { stdio: 'ignore' });
    fs.unlinkSync(tmp);
    // tarball extracts as "cloudflared"
    const extracted = path.join(binDir, 'cloudflared');
    if (extracted !== binPath && fs.existsSync(extracted)) {
      fs.renameSync(extracted, binPath);
    }
  } else {
    fs.renameSync(tmp, binPath);
  }

  if (platform !== 'win32') {
    fs.chmodSync(binPath, 0o755);
  }

  if (!isValidBinary(binPath)) {
    throw new Error('Downloaded cloudflared binary failed validation');
  }

  console.log(`[tunnel] cloudflared ready: ${binPath}`);
  return binPath;
}
