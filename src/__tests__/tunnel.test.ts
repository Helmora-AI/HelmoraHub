import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../tunnel/cloudflared-bin.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared-mock'),
  getCloudflaredDownloadStatus: vi.fn(() => ({ downloading: false, progress: 0 })),
}));

const spawnMock = vi.fn();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

describe('token tunnel manager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-tunnel-'));
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { stopTunnel } = await import('../tunnel/manager.js');
    await stopTunnel();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('starts with token and reports registered connection', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = process.pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);

    const { startTokenTunnel, getTunnelStatus, stopTunnel } = await import(
      '../tunnel/manager.js'
    );

    const startPromise = startTokenTunnel({
      dataDir: tmpDir,
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.token',
      localPort: 20800,
      hostname: 'hub.example.com',
      autoRestart: false,
    });

    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('Registered tunnel connection connIndex=0'));
    });

    const status = await startPromise;
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.publicUrl).toBe('https://hub.example.com');
    expect(spawnMock).toHaveBeenCalled();
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--token');
    expect(args).toContain('run');

    await stopTunnel();
    expect(getTunnelStatus().running).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });
});
