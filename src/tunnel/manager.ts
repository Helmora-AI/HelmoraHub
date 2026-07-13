import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureCloudflared, getCloudflaredDownloadStatus } from './cloudflared-bin.js';

export type TunnelStatus = {
  running: boolean;
  enabled: boolean;
  pid: number | null;
  mode: 'token';
  hostname: string | null;
  publicUrl: string | null;
  localPort: number;
  startedAt: number | null;
  lastError: string | null;
  download: { downloading: boolean; progress: number };
};

type TunnelRuntime = {
  child: ChildProcess | null;
  intentionalStop: boolean;
  startedAt: number | null;
  lastError: string | null;
  localPort: number;
  hostname: string | null;
  tokenPresent: boolean;
  enabled: boolean;
  dataDir: string;
  restartTimer: NodeJS.Timeout | null;
  logTail: string;
};

const runtime: TunnelRuntime = {
  child: null,
  intentionalStop: false,
  startedAt: null,
  lastError: null,
  localPort: 20800,
  hostname: null,
  tokenPresent: false,
  enabled: false,
  dataDir: '',
  restartTimer: null,
  logTail: '',
};

function pidFile(dataDir: string): string {
  return path.join(dataDir, 'tunnel', 'cloudflared.pid');
}

function writePid(dataDir: string, pid: number): void {
  const dir = path.dirname(pidFile(dataDir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFile(dataDir), String(pid), 'utf8');
}

function clearPid(dataDir: string): void {
  try {
    fs.unlinkSync(pidFile(dataDir));
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getTunnelStatus(): TunnelStatus {
  const running = Boolean(runtime.child?.pid && isProcessAlive(runtime.child.pid));
  const publicUrl = runtime.hostname
    ? runtime.hostname.startsWith('http')
      ? runtime.hostname
      : `https://${runtime.hostname}`
    : null;

  return {
    running,
    enabled: runtime.enabled,
    pid: running ? runtime.child!.pid! : null,
    mode: 'token',
    hostname: runtime.hostname,
    publicUrl,
    localPort: runtime.localPort,
    startedAt: runtime.startedAt,
    lastError: runtime.lastError,
    download: getCloudflaredDownloadStatus(),
  };
}

export type StartTunnelInput = {
  dataDir: string;
  token: string;
  localPort: number;
  hostname?: string | null;
  /** Auto-restart on unexpected exit */
  autoRestart?: boolean;
};

/**
 * Start named Cloudflare Tunnel with connector token.
 * Hostname/routing is configured in Cloudflare Zero Trust dashboard
 * (Public Hostname → http://127.0.0.1:PORT).
 */
export async function startTokenTunnel(input: StartTunnelInput): Promise<TunnelStatus> {
  const token = input.token.trim();
  if (!token) throw new Error('Cloudflare tunnel token is required');

  runtime.dataDir = input.dataDir;
  runtime.localPort = input.localPort;
  runtime.hostname = input.hostname?.trim() || null;
  runtime.tokenPresent = true;
  runtime.enabled = true;
  runtime.lastError = null;

  if (runtime.child?.pid && isProcessAlive(runtime.child.pid)) {
    return getTunnelStatus();
  }

  const binary = await ensureCloudflared(input.dataDir);

  // Named tunnel with token: Cloudflare dashboard maps hostname → local service.
  // We still pass metrics-friendly flags; origin is in the token's tunnel config.
  const args = ['tunnel', '--no-autoupdate', 'run', '--token', token];

  runtime.intentionalStop = false;
  runtime.logTail = '';

  const child = spawn(binary, args, {
    detached: false,
    windowsHide: true,
    cwd: input.dataDir,
    env: {
      ...process.env,
      // Prefer http2 for restrictive networks / panels
      TUNNEL_TRANSPORT_PROTOCOL:
        process.env.TUNNEL_TRANSPORT_PROTOCOL ||
        process.env.CLOUDFLARED_PROTOCOL ||
        'http2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runtime.child = child;
  runtime.startedAt = Date.now();
  if (child.pid) writePid(input.dataDir, child.pid);

  const onLog = (buf: Buffer) => {
    const msg = buf.toString();
    runtime.logTail = (runtime.logTail + msg).slice(-6000);
    if (/Registered tunnel connection/i.test(msg)) {
      console.log('[tunnel] Cloudflare connector registered');
    }
    if (/failed|unauthorized|invalid token/i.test(msg)) {
      runtime.lastError = msg.trim().slice(0, 400);
    }
  };

  child.stdout?.on('data', onLog);
  child.stderr?.on('data', onLog);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Token tunnels may take a few seconds; if still alive, treat as started
      if (child.pid && isProcessAlive(child.pid)) resolve();
      else {
        runtime.lastError = runtime.logTail.slice(-500) || 'tunnel start timed out';
        reject(new Error(runtime.lastError));
      }
    }, 25_000);

    const maybeReady = (buf: Buffer) => {
      const msg = buf.toString();
      if (/Registered tunnel connection/i.test(msg) && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on('data', maybeReady);
    child.stderr?.on('data', maybeReady);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      runtime.lastError = err.message;
      reject(err);
    });

    child.on('exit', (code) => {
      runtime.child = null;
      clearPid(input.dataDir);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const err =
          runtime.logTail.slice(-500) ||
          `cloudflared exited with code ${code} before ready (check token)`;
        runtime.lastError = err;
        reject(new Error(err));
        return;
      }
      if (runtime.intentionalStop) return;
      runtime.lastError = `cloudflared exited unexpectedly (code ${code})`;
      console.warn(`[tunnel] ${runtime.lastError}`);
      if (input.autoRestart !== false && runtime.enabled) {
        scheduleRestart(input);
      }
    });
  });

  console.log(
    `[tunnel] started (pid=${child.pid}) localPort=${input.localPort}` +
      (runtime.hostname ? ` hostname=${runtime.hostname}` : '')
  );
  return getTunnelStatus();
}

function scheduleRestart(input: StartTunnelInput): void {
  if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
  runtime.restartTimer = setTimeout(() => {
    runtime.restartTimer = null;
    if (!runtime.enabled || runtime.intentionalStop) return;
    console.log('[tunnel] auto-restarting…');
    startTokenTunnel(input).catch((err) => {
      console.error('[tunnel] auto-restart failed:', err);
      runtime.lastError = err instanceof Error ? err.message : String(err);
    });
  }, 5_000);
}

export async function stopTunnel(): Promise<TunnelStatus> {
  runtime.enabled = false;
  runtime.intentionalStop = true;
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
  }

  const child = runtime.child;
  if (child?.pid && isProcessAlive(child.pid)) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    // Force kill after grace period
    await new Promise((r) => setTimeout(r, 1500));
    if (child.pid && isProcessAlive(child.pid)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  runtime.child = null;
  runtime.startedAt = null;
  if (runtime.dataDir) clearPid(runtime.dataDir);
  console.log('[tunnel] stopped');
  return getTunnelStatus();
}

export function configureTunnelMeta(meta: {
  dataDir: string;
  localPort: number;
  hostname: string | null;
  tokenPresent: boolean;
  enabled: boolean;
}): void {
  runtime.dataDir = meta.dataDir;
  runtime.localPort = meta.localPort;
  runtime.hostname = meta.hostname;
  runtime.tokenPresent = meta.tokenPresent;
  runtime.enabled = meta.enabled;
}
