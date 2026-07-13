import fs from 'node:fs';
import path from 'node:path';
import { getActiveConfig } from '../lib/config.js';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecret,
} from '../lib/crypto.js';
import {
  readRuntimeConfig,
  updateTunnelConfig,
  type TunnelConfig,
} from '../lib/runtime-config.js';
import {
  configureTunnelMeta,
  getTunnelStatus,
  startTokenTunnel,
  stopTunnel,
  type TunnelStatus,
} from '../tunnel/manager.js';

export function resolveEncryptionKey(): string | null {
  const config = getActiveConfig();
  return (
    process.env.ENCRYPTION_KEY?.trim() ||
    config.encryptionKey ||
    readRuntimeConfig(config.dataDir).encryptionKey ||
    null
  );
}

/** Panel-friendly: drop token into data/cloudflare-tunnel.token via File Manager. */
export function tunnelTokenFilePath(dataDir: string): string {
  return path.join(dataDir, 'cloudflare-tunnel.token');
}

export function readTunnelTokenFile(dataDir: string): string | null {
  const file = tunnelTokenFilePath(dataDir);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Plain token priority:
 * 1. CLOUDFLARE_TUNNEL_TOKEN env
 * 2. data/cloudflare-tunnel.token (Pterodactyl File Manager)
 * 3. runtime-config.json (Settings UI, encrypted when possible)
 */
export function resolveTunnelToken(tunnel: TunnelConfig): string | null {
  const fromEnv = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const config = getActiveConfig();
  const fromFile = readTunnelTokenFile(config.dataDir);
  if (fromFile) return fromFile;

  if (!tunnel.token) return null;
  if (!isEncryptedSecret(tunnel.token)) return tunnel.token;

  const key = resolveEncryptionKey();
  if (!key) {
    throw new Error(
      'Tunnel token is encrypted but ENCRYPTION_KEY is missing — set it in Settings or env'
    );
  }
  return decryptSecret(tunnel.token, key);
}

export function sealTunnelToken(plain: string): string {
  const key = resolveEncryptionKey();
  if (key) return encryptSecret(plain, key);
  return plain;
}

export function resolveTunnelHostname(tunnel: TunnelConfig): string | null {
  return (
    tunnel.hostname?.trim() ||
    process.env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim() ||
    null
  );
}

export function syncTunnelMetaFromConfig(): void {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  const token = (() => {
    try {
      return resolveTunnelToken(runtime.tunnel);
    } catch {
      return null;
    }
  })();

  configureTunnelMeta({
    dataDir: config.dataDir,
    localPort: config.port,
    hostname: resolveTunnelHostname(runtime.tunnel),
    tokenPresent: Boolean(token),
    enabled: runtime.tunnel.enabled,
  });
}

export function tunnelPublicPayload(status: TunnelStatus) {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  const encKey = resolveEncryptionKey();
  const fromFile = Boolean(readTunnelTokenFile(config.dataDir));

  return {
    ...status,
    autoStart: runtime.tunnel.autoStart,
    hasToken: Boolean(
      runtime.tunnel.token ||
        process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim() ||
        fromFile
    ),
    tokenPreview: process.env.CLOUDFLARE_TUNNEL_TOKEN
      ? maskSecret(process.env.CLOUDFLARE_TUNNEL_TOKEN)
      : fromFile
        ? 'file:***'
        : runtime.tunnel.token
          ? isEncryptedSecret(runtime.tunnel.token)
            ? 'enc:***'
            : maskSecret(runtime.tunnel.token)
          : null,
    tokenEncryptedAtRest: Boolean(
      runtime.tunnel.token && isEncryptedSecret(runtime.tunnel.token)
    ),
    tokenFromFile: fromFile,
    canEncrypt: Boolean(encKey),
    envTokenOverrides: Boolean(process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim()),
    hint: {
      dashboard:
        'Zero Trust → Networks → Tunnels → your tunnel → Public Hostname → http://127.0.0.1:' +
        config.port,
      token:
        'Settings UI, or .env CLOUDFLARE_TUNNEL_TOKEN, or file data/cloudflare-tunnel.token',
    },
  };
}

export async function startTunnelFromSavedConfig(): Promise<TunnelStatus> {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  const token = resolveTunnelToken(runtime.tunnel);
  if (!token) {
    throw new Error(
      'No tunnel token — paste one in Settings or set CLOUDFLARE_TUNNEL_TOKEN'
    );
  }

  return startTokenTunnel({
    dataDir: config.dataDir,
    token,
    localPort: config.port,
    hostname: resolveTunnelHostname(runtime.tunnel),
    autoRestart: true,
  });
}

export async function maybeAutoStartTunnel(): Promise<void> {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  const envForce =
    process.env.CLOUDFLARE_TUNNEL_AUTO_START === '1' ||
    process.env.CLOUDFLARE_TUNNEL_AUTO_START === 'true';
  const envDisable =
    process.env.CLOUDFLARE_TUNNEL_AUTO_START === '0' ||
    process.env.CLOUDFLARE_TUNNEL_AUTO_START === 'false';

  if (envDisable) {
    syncTunnelMetaFromConfig();
    return;
  }

  const fromEnv = Boolean(process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim());
  const fromFile = Boolean(readTunnelTokenFile(config.dataDir));
  let fromConfig = false;
  try {
    fromConfig = Boolean(resolveTunnelToken(runtime.tunnel));
  } catch {
    fromConfig = false;
  }
  const hasToken = fromEnv || fromFile || fromConfig;

  // Panel/.env/file token → auto-start (no Settings toggle required)
  const externalToken = fromEnv || fromFile;
  const shouldStart =
    envForce ||
    (externalToken && runtime.tunnel.autoStart !== false) ||
    (runtime.tunnel.enabled && runtime.tunnel.autoStart && hasToken);

  syncTunnelMetaFromConfig();

  if (!shouldStart) return;

  try {
    if ((envForce || externalToken) && !runtime.tunnel.enabled) {
      updateTunnelConfig(config.dataDir, { enabled: true, autoStart: true });
    }
    const status = await startTunnelFromSavedConfig();
    console.log(
      `[tunnel] auto-started` +
        (status.publicUrl ? ` → ${status.publicUrl}` : ' (set hostname in Settings for display)')
    );
  } catch (err) {
    console.error(
      '[tunnel] auto-start failed:',
      err instanceof Error ? err.message : err
    );
  }
}
