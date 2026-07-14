import type Database from 'better-sqlite3';
import type { AgentConfig, ProviderToggle } from '../types.js';
import type { ApiKeyRecord } from '../keys/types.js';
import {
  countPendingOutbox,
  sortOutboxPending,
  type ControlOutboxOp,
} from './control-plane.js';
import type { ConnectorCredentialRecord } from './types.js';
import type { RegisteredConnectorId } from '../tools/types.js';

export function ensureControlVaultSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_vault_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at INTEGER,
      generation INTEGER NOT NULL DEFAULT 0,
      plane_json TEXT
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
  `);
}

export class ControlVault {
  constructor(private readonly db: Database.Database) {
    ensureControlVaultSchema(this.db);
  }

  setMeta(patch: {
    lastSyncAt?: number | null;
    generation?: number;
    planeJson?: string | null;
  }): void {
    const cur = this.db
      .prepare('SELECT last_sync_at, generation, plane_json FROM control_vault_meta WHERE id = 1')
      .get() as { last_sync_at: number | null; generation: number; plane_json: string | null };
    this.db
      .prepare(
        `UPDATE control_vault_meta SET
          last_sync_at = ?,
          generation = ?,
          plane_json = ?
         WHERE id = 1`
      )
      .run(
        patch.lastSyncAt !== undefined ? patch.lastSyncAt : cur.last_sync_at,
        patch.generation !== undefined ? patch.generation : cur.generation,
        patch.planeJson !== undefined ? patch.planeJson : cur.plane_json
      );
  }

  getMeta(): {
    lastSyncAt: number | null;
    generation: number;
    planeJson: string | null;
  } {
    const row = this.db
      .prepare('SELECT last_sync_at, generation, plane_json FROM control_vault_meta WHERE id = 1')
      .get() as { last_sync_at: number | null; generation: number; plane_json: string | null };
    return {
      lastSyncAt: row.last_sync_at,
      generation: row.generation,
      planeJson: row.plane_json,
    };
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
