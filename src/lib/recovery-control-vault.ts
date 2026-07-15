import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './crypto.js';

const RECOVERY_CONTROL_VAULT_VERSION = 1 as const;

type RecoveryControlVaultFile = {
  version: typeof RECOVERY_CONTROL_VAULT_VERSION;
  supabaseServiceRoleKeyEncrypted: string;
  updatedAt: number;
};

export function recoveryControlVaultPath(dataDir: string): string {
  return path.join(dataDir, 'recovery-control-vault.json');
}

function readVaultFile(dataDir: string): RecoveryControlVaultFile | null {
  const file = recoveryControlVaultPath(dataDir);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RecoveryControlVaultFile>;
  if (
    parsed.version !== RECOVERY_CONTROL_VAULT_VERSION ||
    !isEncryptedSecret(parsed.supabaseServiceRoleKeyEncrypted) ||
    typeof parsed.updatedAt !== 'number' ||
    !Number.isFinite(parsed.updatedAt)
  ) {
    throw new Error('Invalid local recovery control vault');
  }
  return parsed as RecoveryControlVaultFile;
}

export function readRecoverySupabaseCredential(
  dataDir: string,
  encryptionKey: string | null | undefined
): string | null {
  const record = readVaultFile(dataDir);
  if (!record) return null;
  if (!encryptionKey) {
    throw new Error(
      'ENCRYPTION_KEY is required to open the local recovery control vault'
    );
  }
  return decryptSecret(record.supabaseServiceRoleKeyEncrypted, encryptionKey);
}

export function writeRecoverySupabaseCredential(
  dataDir: string,
  encryptionKey: string,
  plaintext: string
): void {
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required to write recovery credentials');
  }
  if (!plaintext.trim()) throw new Error('Supabase credential cannot be empty');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = recoveryControlVaultPath(dataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  const payload: RecoveryControlVaultFile = {
    version: RECOVERY_CONTROL_VAULT_VERSION,
    supabaseServiceRoleKeyEncrypted: encryptSecret(plaintext.trim(), encryptionKey),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function recoverySupabaseCredentialConfigured(dataDir: string): boolean {
  return readVaultFile(dataDir) != null;
}

export function clearRecoverySupabaseCredential(dataDir: string): void {
  const file = recoveryControlVaultPath(dataDir);
  if (fs.existsSync(file)) fs.rmSync(file);
}
