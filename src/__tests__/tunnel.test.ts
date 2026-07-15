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

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-tunnel-'));
    spawnMock.mockReset();
    const { ensureCloudflared } = await import('../tunnel/cloudflared-bin.js');
    vi.mocked(ensureCloudflared).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  it('keeps retrying when startup and the first reconnect fail before ready', async () => {
    vi.useFakeTimers();
    const children = Array.from({ length: 3 }, () => {
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
      return child;
    });
    spawnMock
      .mockImplementationOnce(() => children[0])
      .mockImplementationOnce(() => children[1])
      .mockImplementationOnce(() => children[2]);

    const { startTokenTunnel, getTunnelStatus } = await import('../tunnel/manager.js');
    const input = {
      dataDir: tmpDir,
      token: 'test-token',
      localPort: 20800,
      hostname: 'hub.example.com',
      autoRestart: true,
    };

    const initial = startTokenTunnel(input);
    queueMicrotask(() => children[0].emit('exit', 1));
    await expect(initial).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[1].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    children[2].stderr.emit('data', Buffer.from('Registered tunnel connection connIndex=0'));
    await vi.advanceTimersByTimeAsync(0);

    expect(getTunnelStatus()).toMatchObject({ running: true, lastError: null });
  });

  it('retries when cloudflared preparation fails during boot', async () => {
    vi.useFakeTimers();
    const { ensureCloudflared } = await import('../tunnel/cloudflared-bin.js');
    vi.mocked(ensureCloudflared).mockRejectedValueOnce(new Error('temporary download failure'));
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
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.stderr.emit('data', Buffer.from('Registered tunnel connection connIndex=0')));
      return child;
    });

    const { startTokenTunnel, getTunnelStatus } = await import('../tunnel/manager.js');
    const initial = startTokenTunnel({
      dataDir: tmpDir,
      token: 'test-token',
      localPort: 20800,
      autoRestart: true,
    });
    await expect(initial).rejects.toThrow('temporary download failure');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ensureCloudflared).toHaveBeenCalledTimes(2);
    expect(getTunnelStatus().running).toBe(true);
  });
});
