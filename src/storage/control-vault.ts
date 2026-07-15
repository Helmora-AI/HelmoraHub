import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { HUB_MODES, type AgentConfig, type ProviderToggle } from '../types.js';
import type { ApiKeyRecord } from '../keys/types.js';
import {
  countPendingOutbox,
  sortOutboxPending,
  type ControlOutboxOp,
} from './control-plane.js';
import type { ConnectorCredentialRecord } from './types.js';
import type { RegisteredConnectorId } from '../tools/types.js';
import { isEncryptedSecret } from '../lib/crypto.js';

export const CONTROL_SNAPSHOT_FORMAT_VERSION = 1 as const;
export const CONTROL_SNAPSHOT_BUILD_SCHEMA_VERSION = 1;

export type ControlSnapshotCapability = {
  id: string;
  tier: 'core_serving' | 'enabled_feature' | 'optional_admin';
  present: boolean;
};

export type ControlSnapshotManifest = {
  generation: number;
  formatVersion: typeof CONTROL_SNAPSHOT_FORMAT_VERSION;
  buildSchemaVersion: number;
  createdAt: number;
  completedAt: number;
  complete: true;
  capabilities: ControlSnapshotCapability[];
  entityCounts: Record<string, number>;
  checksum: string;
};

export type LegacySnapshotPromotionResult =
  | { ok: true; manifest: ControlSnapshotManifest; warnings: string[] }
  | {
      ok: false;
      reason:
        | 'trusted_sync_marker_missing'
        | 'migration_in_progress'
        | 'required_capability_missing'
        | 'untrusted_legacy_rows'
        | 'invalid_legacy_data';
      missingCapabilities?: string[];
    };

export function ensureControlVaultSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_vault_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at INTEGER,
      generation INTEGER NOT NULL DEFAULT 0,
      plane_json TEXT,
      active_generation INTEGER,
      migration_state TEXT NOT NULL DEFAULT 'complete'
    );

    INSERT OR IGNORE INTO control_vault_meta (id, last_sync_at, generation, plane_json)
    VALUES (1, NULL, 0, NULL);

    CREATE TABLE IF NOT EXISTS control_vault_providers (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS control_vault_api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS control_vault_agents (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS control_vault_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS control_vault_connector_credentials (
      connector_id TEXT PRIMARY KEY,
      encrypted_secret TEXT NOT NULL,
      encryption_version INTEGER NOT NULL,
      configured_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS control_outbox (
      op_id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      applied_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS control_outbox_pending_idx
      ON control_outbox (created_at, op_id)
      WHERE applied_at IS NULL;

    CREATE TABLE IF NOT EXISTS control_snapshot_manifests (
      generation INTEGER PRIMARY KEY,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const metaColumns = new Set(
    (db.prepare('PRAGMA table_info(control_vault_meta)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!metaColumns.has('active_generation')) {
    db.exec('ALTER TABLE control_vault_meta ADD COLUMN active_generation INTEGER');
  }
  if (!metaColumns.has('migration_state')) {
    db.exec(
      "ALTER TABLE control_vault_meta ADD COLUMN migration_state TEXT NOT NULL DEFAULT 'complete'"
    );
  }
}

export class ControlVault {
  constructor(private readonly db: Database.Database) {
    ensureControlVaultSchema(this.db);
  }

  setMeta(patch: {
    lastSyncAt?: number | null;
    generation?: number;
    planeJson?: string | null;
    activeGeneration?: number | null;
    migrationState?: 'complete' | 'running';
  }): void {
    const cur = this.db
      .prepare(
        `SELECT last_sync_at, generation, plane_json, active_generation, migration_state
         FROM control_vault_meta WHERE id = 1`
      )
      .get() as {
      last_sync_at: number | null;
      generation: number;
      plane_json: string | null;
      active_generation: number | null;
      migration_state: 'complete' | 'running';
    };
    this.db
      .prepare(
        `UPDATE control_vault_meta SET
          last_sync_at = ?,
          generation = ?,
          plane_json = ?,
          active_generation = ?,
          migration_state = ?
         WHERE id = 1`
      )
      .run(
        patch.lastSyncAt !== undefined ? patch.lastSyncAt : cur.last_sync_at,
        patch.generation !== undefined ? patch.generation : cur.generation,
        patch.planeJson !== undefined ? patch.planeJson : cur.plane_json,
        patch.activeGeneration !== undefined
          ? patch.activeGeneration
          : cur.active_generation,
        patch.migrationState !== undefined ? patch.migrationState : cur.migration_state
      );
  }

  getMeta(): {
    lastSyncAt: number | null;
    generation: number;
    planeJson: string | null;
    activeGeneration: number | null;
    migrationState: 'complete' | 'running';
  } {
    const row = this.db
      .prepare(
        `SELECT last_sync_at, generation, plane_json, active_generation, migration_state
         FROM control_vault_meta WHERE id = 1`
      )
      .get() as {
      last_sync_at: number | null;
      generation: number;
      plane_json: string | null;
      active_generation: number | null;
      migration_state: 'complete' | 'running';
    };
    return {
      lastSyncAt: row.last_sync_at,
      generation: row.generation,
      planeJson: row.plane_json,
      activeGeneration: row.active_generation,
      migrationState: row.migration_state,
    };
  }

  getActiveSnapshotManifest(): ControlSnapshotManifest | null {
    const activeGeneration = this.getMeta().activeGeneration;
    if (activeGeneration == null) return null;
    const row = this.db
      .prepare('SELECT manifest_json FROM control_snapshot_manifests WHERE generation = ?')
      .get(activeGeneration) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as ControlSnapshotManifest) : null;
  }

  promoteLegacyGenerationZero(now = Date.now()): LegacySnapshotPromotionResult {
    const existing = this.getActiveSnapshotManifest();
    if (existing) return { ok: true, manifest: existing, warnings: [] };

    const meta = this.getMeta();
    if (meta.lastSyncAt == null) {
      return { ok: false, reason: 'trusted_sync_marker_missing' };
    }
    if (meta.migrationState !== 'complete') {
      return { ok: false, reason: 'migration_in_progress' };
    }

    try {
      const providers = this.listProviders();
      const apiKeys = this.listApiKeys();
      const agents = this.listAgents();
      const activeMode = this.getSetting('active_mode');
      const tinyfishEnabled = this.tinyfishFeatureEnabled();
      const tinyfishCredential = this.getConnectorCredential('tinyfish');
      const capabilities: ControlSnapshotCapability[] = [
        { id: 'providers', tier: 'core_serving', present: providers.length > 0 },
        {
          id: 'api_keys',
          tier: 'core_serving',
          present: apiKeys.length > 0 && apiKeys.every((key) => Boolean(key.keyHash)),
        },
        {
          id: 'agents',
          tier: 'core_serving',
          present:
            agents.length > 0 && agents.every((agent) => HUB_MODES.includes(agent.mode)),
        },
        {
          id: 'active_mode',
          tier: 'core_serving',
          present: activeMode != null && HUB_MODES.includes(activeMode as (typeof HUB_MODES)[number]),
        },
        {
          id: 'pricing_overrides',
          tier: 'optional_admin',
          present: this.getSetting('pricing_overrides') != null,
        },
      ];
      if (tinyfishEnabled) {
        capabilities.push({
          id: 'tinyfish_connector_credential',
          tier: 'enabled_feature',
          present:
            tinyfishCredential != null &&
            isEncryptedSecret(tinyfishCredential.encryptedSecret),
        });
      }
      const missingCapabilities = capabilities
        .filter((capability) => capability.tier !== 'optional_admin' && !capability.present)
        .map((capability) => capability.id);
      if (missingCapabilities.length > 0) {
        return {
          ok: false,
          reason: 'required_capability_missing',
          missingCapabilities,
        };
      }

      const maxRequiredUpdate = this.maxRequiredLegacyUpdatedAt(tinyfishEnabled);
      if (maxRequiredUpdate == null || maxRequiredUpdate > meta.lastSyncAt) {
        return { ok: false, reason: 'untrusted_legacy_rows' };
      }

      const entityCounts = {
        providers: providers.length,
        apiKeys: apiKeys.length,
        agents: agents.length,
        connectorCredentials: this.countRows('control_vault_connector_credentials'),
      };
      const checksum = createHash('sha256')
        .update(
          JSON.stringify({
            providers,
            apiKeys,
            agents,
            activeMode,
            entityCounts,
            lastSyncAt: meta.lastSyncAt,
          })
        )
        .digest('hex');
      const manifest: ControlSnapshotManifest = {
        generation: 0,
        formatVersion: CONTROL_SNAPSHOT_FORMAT_VERSION,
        buildSchemaVersion: CONTROL_SNAPSHOT_BUILD_SCHEMA_VERSION,
        createdAt: now,
        completedAt: now,
        complete: true,
        capabilities,
        entityCounts,
        checksum,
      };
      const activate = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO control_snapshot_manifests (generation, manifest_json, created_at)
             VALUES (?, ?, ?)`
          )
          .run(0, JSON.stringify(manifest), now);
        this.db
          .prepare('UPDATE control_vault_meta SET active_generation = 0 WHERE id = 1')
          .run();
      });
      activate();
      return {
        ok: true,
        manifest,
        warnings: capabilities
          .filter((capability) => capability.tier === 'optional_admin' && !capability.present)
          .map((capability) => capability.id),
      };
    } catch {
      return { ok: false, reason: 'invalid_legacy_data' };
    }
  }

  private countRows(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  private tinyfishFeatureEnabled(): boolean {
    const raw = this.getSetting('tool_runtime_v1');
    if (raw == null) return false;
    const parsed = JSON.parse(raw) as {
      enabled?: unknown;
      connectors?: { tinyfish?: { enabled?: unknown } };
    };
    return parsed.enabled === true && parsed.connectors?.tinyfish?.enabled === true;
  }

  private maxRequiredLegacyUpdatedAt(includeTinyfish: boolean): number | null {
    const settingKeys = includeTinyfish
      ? "key IN ('active_mode', 'tool_runtime_v1')"
      : "key = 'active_mode'";
    const connectorRows = includeTinyfish
      ? 'UNION ALL SELECT updated_at FROM control_vault_connector_credentials WHERE connector_id = \'tinyfish\''
      : '';
    const row = this.db
      .prepare(
        `SELECT MAX(updated_at) AS updated_at FROM (
           SELECT updated_at FROM control_vault_providers
           UNION ALL SELECT updated_at FROM control_vault_api_keys
           UNION ALL SELECT updated_at FROM control_vault_agents
           UNION ALL SELECT updated_at FROM control_vault_settings WHERE ${settingKeys}
           ${connectorRows}
         )`
      )
      .get() as { updated_at: number | null };
    return row.updated_at;
  }

  upsertProvider(provider: ProviderToggle, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO control_vault_providers (id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
      )
      .run(provider.id, JSON.stringify(provider), updatedAt);
  }

  getProvider(id: string): ProviderToggle | null {
    const row = this.db
      .prepare('SELECT payload_json FROM control_vault_providers WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ProviderToggle) : null;
  }

  listProviders(): ProviderToggle[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM control_vault_providers ORDER BY id ASC')
      .all() as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as ProviderToggle);
  }

  deleteProvider(id: string): boolean {
    return this.db.prepare('DELETE FROM control_vault_providers WHERE id = ?').run(id).changes > 0;
  }

  upsertApiKey(record: ApiKeyRecord, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO control_vault_api_keys (id, key_hash, payload_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key_hash = excluded.key_hash,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run(record.id, record.keyHash, JSON.stringify(record), updatedAt);
  }

  getApiKey(id: string): ApiKeyRecord | null {
    const row = this.db
      .prepare('SELECT payload_json FROM control_vault_api_keys WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ApiKeyRecord) : null;
  }

  findApiKeyByHash(keyHash: string): ApiKeyRecord | null {
    const row = this.db
      .prepare('SELECT payload_json FROM control_vault_api_keys WHERE key_hash = ?')
      .get(keyHash) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ApiKeyRecord) : null;
  }

  listApiKeys(): ApiKeyRecord[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM control_vault_api_keys ORDER BY id ASC')
      .all() as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as ApiKeyRecord);
  }

  deleteApiKey(id: string): boolean {
    return this.db.prepare('DELETE FROM control_vault_api_keys WHERE id = ?').run(id).changes > 0;
  }

  upsertAgent(agent: AgentConfig, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO control_vault_agents (id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
      )
      .run(agent.id, JSON.stringify(agent), updatedAt);
  }

  listAgents(): AgentConfig[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM control_vault_agents ORDER BY id ASC')
      .all() as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as AgentConfig);
  }

  setSetting(key: string, value: string, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO control_vault_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, updatedAt);
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM control_vault_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  upsertConnectorCredential(record: ConnectorCredentialRecord): void {
    this.db.prepare(
      `INSERT INTO control_vault_connector_credentials
        (connector_id, encrypted_secret, encryption_version, configured_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET
         encrypted_secret = excluded.encrypted_secret,
         encryption_version = excluded.encryption_version,
         configured_at = excluded.configured_at,
         updated_at = excluded.updated_at`
    ).run(
      record.connectorId,
      record.encryptedSecret,
      record.encryptionVersion,
      record.configuredAt,
      record.updatedAt,
    );
  }

  getConnectorCredential(connectorId: RegisteredConnectorId): ConnectorCredentialRecord | null {
    const row = this.db.prepare(
      `SELECT connector_id, encrypted_secret, encryption_version, configured_at, updated_at
       FROM control_vault_connector_credentials WHERE connector_id = ?`
    ).get(connectorId) as {
      connector_id: RegisteredConnectorId;
      encrypted_secret: string;
      encryption_version: number;
      configured_at: number;
      updated_at: number;
    } | undefined;
    if (!row) return null;
    if (row.encryption_version !== 1) {
      throw new Error('Unsupported connector credential encryption version');
    }
    return {
      connectorId: row.connector_id,
      encryptedSecret: row.encrypted_secret,
      encryptionVersion: 1,
      configuredAt: row.configured_at,
      updatedAt: row.updated_at,
    };
  }

  deleteConnectorCredential(connectorId: RegisteredConnectorId): boolean {
    return this.db.prepare(
      'DELETE FROM control_vault_connector_credentials WHERE connector_id = ?'
    ).run(connectorId).changes > 0;
  }

  enqueueOutbox(op: ControlOutboxOp): void {
    this.db
      .prepare(
        `INSERT INTO control_outbox
          (op_id, entity, action, entity_id, payload_json, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        op.opId,
        op.entity,
        op.action,
        op.entityId,
        JSON.stringify(op.payload),
        op.createdAt,
        op.appliedAt
      );
  }

  listPendingOutbox(): ControlOutboxOp[] {
    const rows = this.db
      .prepare(
        `SELECT op_id, entity, action, entity_id, payload_json, created_at, applied_at
         FROM control_outbox WHERE applied_at IS NULL`
      )
      .all() as Array<{
      op_id: string;
      entity: ControlOutboxOp['entity'];
      action: ControlOutboxOp['action'];
      entity_id: string;
      payload_json: string;
      created_at: number;
      applied_at: number | null;
    }>;
    const ops: ControlOutboxOp[] = rows.map((r) => ({
      opId: r.op_id,
      entity: r.entity,
      action: r.action,
      entityId: r.entity_id,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      createdAt: r.created_at,
      appliedAt: r.applied_at,
    }));
    return sortOutboxPending(ops);
  }

  markOutboxApplied(opId: string, appliedAt: number): boolean {
    const row = this.db
      .prepare('SELECT applied_at FROM control_outbox WHERE op_id = ?')
      .get(opId) as { applied_at: number | null } | undefined;
    if (!row) return false;
    if (row.applied_at != null) return true;
    this.db
      .prepare('UPDATE control_outbox SET applied_at = ? WHERE op_id = ? AND applied_at IS NULL')
      .run(appliedAt, opId);
    return true;
  }

  pendingOutboxCount(): number {
    return countPendingOutbox(this.listPendingOutbox());
  }
}
