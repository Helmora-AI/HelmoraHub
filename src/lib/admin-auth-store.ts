import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  readRuntimeConfig,
  rewriteRuntimeConfigWithoutLegacyAuth,
} from './runtime-config.js';

export type AdminSessionKind = 'cookie' | 'spa';

export type StoredAdminIdentity = {
  passwordHash: string | null;
  adminTokenHash: string | null;
  recoveryTokenHash: string | null;
  createdAt: number;
  updatedAt: number;
};

export type StoredAdminSession = {
  hash: string;
  kind: AdminSessionKind;
  createdAt: number;
  expiresAt: number;
};

export type BootstrapInput = {
  passwordHash: string;
  adminTokenHash: string | null;
  recoveryTokenHash: string | null;
  sessions: StoredAdminSession[];
};

type IdentityRow = {
  password_hash: string | null;
  admin_token_hash: string | null;
  recovery_token_hash: string | null;
  created_at: number;
  updated_at: number;
};

type SessionRow = {
  session_hash: string;
  kind: AdminSessionKind;
  created_at: number;
  expires_at: number;
};

export type AuthStoreMigrationPhase =
  | 'not_started'
  | 'legacy_cleanup_required'
  | 'complete';

export type AuthStoreHealth = {
  ready: boolean;
  warning: 'auth_migration_incomplete' | null;
  migrationVersion: number;
};

type MetaRow = {
  migration_version: number;
  migration_phase: AuthStoreMigrationPhase;
};

export function adminAuthStorePath(dataDir: string): string {
  return path.join(dataDir, 'admin-auth.sqlite');
}

export class AdminAuthStore {
  private readonly db: Database.Database;
  private closed = false;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(adminAuthStorePath(dataDir));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS helmora_admin_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT,
        admin_token_hash TEXT,
        recovery_token_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS helmora_admin_sessions (
        session_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('cookie', 'spa')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
      );

      CREATE INDEX IF NOT EXISTS idx_helmora_admin_sessions_expiry
        ON helmora_admin_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS helmora_auth_store_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        migration_version INTEGER NOT NULL,
        migration_phase TEXT NOT NULL
      );

      INSERT OR IGNORE INTO helmora_auth_store_meta
        (id, schema_version, migration_version, migration_phase)
      VALUES (1, 1, 0, 'not_started');
    `);
  }

  attemptBootstrap(input: BootstrapInput): { created: boolean } {
    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT 1 AS present FROM helmora_admin_identity WHERE id = 1')
        .get() as { present: number } | undefined;
      if (existing) return { created: false };

      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO helmora_admin_identity
            (id, password_hash, admin_token_hash, recovery_token_hash, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?)`
        )
        .run(
          input.passwordHash,
          input.adminTokenHash,
          input.recoveryTokenHash,
          now,
          now
        );

      const insertSession = this.db.prepare(
        `INSERT INTO helmora_admin_sessions
          (session_hash, kind, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const session of input.sessions) {
        insertSession.run(
          session.hash,
          session.kind,
          session.createdAt,
          session.expiresAt
        );
      }

      return { created: true };
    });

    return run.immediate();
  }

  readMigrationState(): {
    version: number;
    phase: AuthStoreMigrationPhase;
  } {
    const row = this.db
      .prepare(
        `SELECT migration_version, migration_phase
         FROM helmora_auth_store_meta
         WHERE id = 1`
      )
      .get() as MetaRow;
    return {
      version: row.migration_version,
      phase: row.migration_phase,
    };
  }

  importLegacyAuth(input: {
    identity: Pick<
      StoredAdminIdentity,
      'passwordHash' | 'adminTokenHash' | 'recoveryTokenHash'
    > | null;
    sessions: StoredAdminSession[];
  }): void {
    const run = this.db.transaction(() => {
      const state = this.readMigrationState();
      if (state.version >= 1) return;

      if (input.identity && !this.readIdentity()) {
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO helmora_admin_identity
              (id, password_hash, admin_token_hash, recovery_token_hash, created_at, updated_at)
             VALUES (1, ?, ?, ?, ?, ?)`
          )
          .run(
            input.identity.passwordHash,
            input.identity.adminTokenHash,
            input.identity.recoveryTokenHash,
            now,
            now
          );
      }

      const insertSession = this.db.prepare(
        `INSERT OR IGNORE INTO helmora_admin_sessions
          (session_hash, kind, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const session of input.sessions) {
        insertSession.run(
          session.hash,
          session.kind,
          session.createdAt,
          session.expiresAt
        );
      }

      this.db
        .prepare(
          `UPDATE helmora_auth_store_meta
           SET migration_version = 1, migration_phase = 'legacy_cleanup_required'
           WHERE id = 1`
        )
        .run();
    });
    run.immediate();
  }

  completeLegacyMigration(): void {
    this.db
      .prepare(
        `UPDATE helmora_auth_store_meta
         SET migration_version = 1, migration_phase = 'complete'
         WHERE id = 1 AND migration_version = 1`
      )
      .run();
  }

  readIdentity(): StoredAdminIdentity | null {
    const row = this.db
      .prepare(
        `SELECT password_hash, admin_token_hash, recovery_token_hash, created_at, updated_at
         FROM helmora_admin_identity
         WHERE id = 1`
      )
      .get() as IdentityRow | undefined;
    if (!row) return null;
    return {
      passwordHash: row.password_hash,
      adminTokenHash: row.admin_token_hash,
      recoveryTokenHash: row.recovery_token_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateIdentity(
    patch: Partial<
      Pick<
        StoredAdminIdentity,
        'passwordHash' | 'adminTokenHash' | 'recoveryTokenHash'
      >
    >
  ): StoredAdminIdentity {
    const current = this.readIdentity();
    if (!current) throw new Error('Admin identity is not configured.');
    const next = {
      passwordHash: patch.passwordHash ?? current.passwordHash,
      adminTokenHash:
        patch.adminTokenHash === undefined
          ? current.adminTokenHash
          : patch.adminTokenHash,
      recoveryTokenHash:
        patch.recoveryTokenHash === undefined
          ? current.recoveryTokenHash
          : patch.recoveryTokenHash,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE helmora_admin_identity
         SET password_hash = ?, admin_token_hash = ?, recovery_token_hash = ?, updated_at = ?
         WHERE id = 1`
      )
      .run(
        next.passwordHash,
        next.adminTokenHash,
        next.recoveryTokenHash,
        next.updatedAt
      );
    return {
      ...current,
      ...next,
    };
  }

  upsertIdentity(
    patch: Partial<
      Pick<
        StoredAdminIdentity,
        'passwordHash' | 'adminTokenHash' | 'recoveryTokenHash'
      >
    >
  ): StoredAdminIdentity {
    const current = this.readIdentity();
    if (current) return this.updateIdentity(patch);

    const now = Date.now();
    const created: StoredAdminIdentity = {
      passwordHash: patch.passwordHash ?? null,
      adminTokenHash: patch.adminTokenHash ?? null,
      recoveryTokenHash: patch.recoveryTokenHash ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO helmora_admin_identity
          (id, password_hash, admin_token_hash, recovery_token_hash, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)`
      )
      .run(
        created.passwordHash,
        created.adminTokenHash,
        created.recoveryTokenHash,
        created.createdAt,
        created.updatedAt
      );
    return created;
  }

  insertSession(session: StoredAdminSession): void {
    this.db
      .prepare(
        `INSERT INTO helmora_admin_sessions
          (session_hash, kind, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(session.hash, session.kind, session.createdAt, session.expiresAt);
  }

  readSession(hash: string): StoredAdminSession | null {
    const row = this.db
      .prepare(
        `SELECT session_hash, kind, created_at, expires_at
         FROM helmora_admin_sessions
         WHERE session_hash = ?`
      )
      .get(hash) as SessionRow | undefined;
    if (!row) return null;
    return {
      hash: row.session_hash,
      kind: row.kind,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  findSession(hash: string, now = Date.now()): StoredAdminSession | null {
    const row = this.db
      .prepare(
        `SELECT session_hash, kind, created_at, expires_at
         FROM helmora_admin_sessions
         WHERE session_hash = ? AND expires_at > ?`
      )
      .get(hash, now) as SessionRow | undefined;
    if (!row) return null;
    return {
      hash: row.session_hash,
      kind: row.kind,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  deleteSessions(hashes: string[]): number {
    const unique = [...new Set(hashes.filter(Boolean))];
    if (unique.length === 0) return 0;
    const placeholders = unique.map(() => '?').join(', ');
    return this.db
      .prepare(
        `DELETE FROM helmora_admin_sessions
         WHERE session_hash IN (${placeholders})`
      )
      .run(...unique).changes;
  }

  pruneExpired(now = Date.now(), limit = 100): number {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db
      .prepare(
        `DELETE FROM helmora_admin_sessions
         WHERE rowid IN (
           SELECT rowid
           FROM helmora_admin_sessions
           WHERE expires_at <= ?
           ORDER BY expires_at ASC
           LIMIT ?
         )`
      )
      .run(now, boundedLimit).changes;
  }

  countSessions(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM helmora_admin_sessions')
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

let activeStore: { dataDir: string; store: AdminAuthStore } | null = null;
let activeHealth: AuthStoreHealth = {
  ready: false,
  warning: 'auth_migration_incomplete',
  migrationVersion: 0,
};

type LegacySessionFile = {
  sessions?: Array<{
    hash?: unknown;
    createdAt?: unknown;
    expiresAt?: unknown;
  }>;
};

export type LegacyMigrationDependencies = {
  rewriteRuntimeConfig?: (dataDir: string) => void;
  consumeSessionFile?: (dataDir: string) => void;
};

function readLegacySessions(dataDir: string): StoredAdminSession[] {
  const file = path.join(dataDir, 'admin-sessions.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacySessionFile;
  const now = Date.now();
  return (Array.isArray(parsed.sessions) ? parsed.sessions : [])
    .filter((session) => {
      return (
        typeof session.hash === 'string' &&
        /^[a-f0-9]{64}$/i.test(session.hash) &&
        typeof session.createdAt === 'number' &&
        Number.isFinite(session.createdAt) &&
        typeof session.expiresAt === 'number' &&
        Number.isFinite(session.expiresAt) &&
        session.expiresAt > session.createdAt &&
        session.expiresAt > now
      );
    })
    .map((session) => ({
      hash: session.hash as string,
      kind: 'spa' as const,
      createdAt: session.createdAt as number,
      expiresAt: session.expiresAt as number,
    }));
}

function consumeLegacySessionFile(dataDir: string): void {
  const source = path.join(dataDir, 'admin-sessions.json');
  const consumed = path.join(dataDir, 'admin-sessions.consumed-v1.json');
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(consumed)) {
    fs.rmSync(source, { force: true });
    return;
  }
  fs.renameSync(source, consumed);
}

export function migrateLegacyAuth(
  store: AdminAuthStore,
  dataDir: string,
  dependencies: LegacyMigrationDependencies = {}
): AuthStoreHealth {
  const rewrite =
    dependencies.rewriteRuntimeConfig ?? rewriteRuntimeConfigWithoutLegacyAuth;
  const consume = dependencies.consumeSessionFile ?? consumeLegacySessionFile;
  const runtime = readRuntimeConfig(dataDir);
  let state = store.readMigrationState();

  if (runtime.authStoreMigrationVersion >= 1 && state.version < 1) {
    return {
      ready: false,
      warning: 'auth_migration_incomplete',
      migrationVersion: 1,
    };
  }

  if (state.version < 1) {
    const legacy = runtime.admin;
    const hasLegacyIdentity = Boolean(
      legacy.passwordHash || legacy.adminTokenHash || legacy.recoveryTokenHash
    );
    store.importLegacyAuth({
      identity: hasLegacyIdentity
        ? {
            passwordHash: legacy.passwordHash,
            adminTokenHash: legacy.adminTokenHash,
            recoveryTokenHash: legacy.recoveryTokenHash,
          }
        : null,
      sessions: readLegacySessions(dataDir),
    });
    state = store.readMigrationState();
  }

  if (state.phase === 'legacy_cleanup_required') {
    try {
      rewrite(dataDir);
      consume(dataDir);
      const reread = readRuntimeConfig(dataDir);
      if (reread.authStoreMigrationVersion !== 1) {
        throw new Error('Runtime auth migration marker was not persisted.');
      }
      store.completeLegacyMigration();
      state = store.readMigrationState();
    } catch {
      return {
        ready: false,
        warning: 'auth_migration_incomplete',
        migrationVersion: 1,
      };
    }
  }

  if (state.version === 1 && state.phase === 'complete') {
    return { ready: true, warning: null, migrationVersion: 1 };
  }
  return {
    ready: false,
    warning: 'auth_migration_incomplete',
    migrationVersion: state.version,
  };
}

export function initializeAdminAuthStore(dataDir: string): AdminAuthStore {
  const resolved = path.resolve(dataDir);
  if (activeStore?.dataDir === resolved) return activeStore.store;
  activeStore?.store.close();
  const store = new AdminAuthStore(resolved);
  activeStore = { dataDir: resolved, store };
  activeHealth = migrateLegacyAuth(store, resolved);
  return store;
}

export function getAdminAuthStore(dataDir: string): AdminAuthStore {
  return initializeAdminAuthStore(dataDir);
}

export function closeAdminAuthStore(): void {
  activeStore?.store.close();
  activeStore = null;
  activeHealth = {
    ready: false,
    warning: 'auth_migration_incomplete',
    migrationVersion: 0,
  };
}

export function getAdminAuthStoreHealth(): AuthStoreHealth {
  return { ...activeHealth };
}
