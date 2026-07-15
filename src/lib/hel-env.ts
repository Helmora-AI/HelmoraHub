/**
 * Brand env / identity helpers.
 * Prefer HELMORA_* ; CTRLHUB_* still accepted as legacy fallback.
 */
export function helEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const primary = env[`HELMORA_${suffix}`]?.trim();
  if (primary) return primary;
  const legacy = env[`CTRLHUB_${suffix}`]?.trim();
  return legacy || undefined;
}

export function helEnvTruthy(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env
): boolean | undefined {
  const raw = helEnv(suffix, env)?.toLowerCase();
  if (raw == null) return undefined;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return undefined;
}

export const HEL_API_KEY_DEV = 'hel_dev_';
export const HEL_API_KEY_PRO = 'hel_pro_';
export const LEGACY_API_KEY_DEV = 'ctrl_dev_';
export const LEGACY_API_KEY_PRO = 'ctrl_pro_';

export const HEL_ADMIN_TOKEN_PREFIX = 'helmora-admin-';
export const LEGACY_ADMIN_TOKEN_PREFIX = 'ctrlhub-admin-';

export const HEL_SESSION_PREFIX = 'helmora_session_';
export const LEGACY_SESSION_PREFIX = 'ctrlhub_session_';

export const HEL_RECOVERY_TOKEN_PREFIX = 'helmora-recovery-token-';
export const HEL_RECOVERY_SESSION_PREFIX = 'helmora_recovery_session_';

export const HEL_COOKIE_NAME = 'helmora_sid';
export const LEGACY_COOKIE_NAME = 'ctrlhub_sid';

export const HEL_DB_FILE = 'helmora.db';
export const LEGACY_DB_FILE = 'ctrlhub.db';

export const HEL_REDIS_PREFIX = 'helmora';

export const HEL_TABLE = {
  settings: 'helmora_settings',
  providers: 'helmora_providers',
  agents: 'helmora_agents',
  connectorCredentials: 'helmora_connector_credentials',
  toolRuns: 'helmora_tool_runs',
} as const;

export function isHelSessionToken(token: string): boolean {
  return (
    token.startsWith(HEL_SESSION_PREFIX) || token.startsWith(LEGACY_SESSION_PREFIX)
  );
}

export function isHelRecoveryToken(token: string): boolean {
  return token.startsWith(HEL_RECOVERY_TOKEN_PREFIX);
}

export function isHelRecoverySessionToken(token: string): boolean {
  return token.startsWith(HEL_RECOVERY_SESSION_PREFIX);
}

export function isHelClientApiKey(token: string): boolean {
  return (
    token.startsWith(HEL_API_KEY_DEV) ||
    token.startsWith(HEL_API_KEY_PRO) ||
    token.startsWith(LEGACY_API_KEY_DEV) ||
    token.startsWith(LEGACY_API_KEY_PRO)
  );
}
