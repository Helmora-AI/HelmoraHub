import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../lib/config.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import { SupabaseConfigStore } from '../storage/supabase-store.js';
import type { ToolRunCreate } from '../storage/types.js';

function baseConfig(overrides: Partial<Config>): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: '.',
    dbPath: ':memory:',
    apiKeyEnv: null,
    upstreamBaseUrl: null,
    upstreamApiKey: null,
    upstreamModel: null,
    encryptionKey: 'tool-audit-test-key',
    storageBackend: 'sqlite',
    storageChoice: 'local',
    rateBackend: 'memory',
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
    redisUrl: null,
    publicUrl: null,
    frontendUrl: null,
    ...overrides,
  };
}

function auditInput(): ToolRunCreate {
  return {
    requestId: 'req_tool_1',
    toolId: 'web_search',
    connector: 'tinyfish',
    surface: 'mini',
    source: 'runtime',
    answerCatalogId: 'catalog_answer',
    plannerCatalogId: null,
    risk: 'read',
    status: 'completed',
    durationMs: 42,
    sourceCount: 3,
    errorCode: null,
  };
}

describe('SQLite tool-run audit', () => {
  const stores: SqliteConfigStore[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('persists and lists only safe bounded dimensions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-tool-audit-'));
    directories.push(directory);
    const dbPath = path.join(directory, 'helmora.db');
    const store = new SqliteConfigStore(baseConfig({ dataDir: directory, dbPath }));
    stores.push(store);
    const secret = 'tf-secret-must-never-enter-audit';
    const hostile = {
      ...auditInput(),
      arguments: { query: secret },
      content: secret,
      rawUrl: `https://example.com/?token=${secret}`,
    } as ToolRunCreate;

    const saved = await store.recordToolRun(hostile);
    const listed = await store.listToolRuns({ limit: 1 });

    expect(saved).toMatchObject(auditInput());
    expect(saved.id).toMatch(/^toolrun_/);
    expect(listed).toEqual([saved]);
    expect(JSON.stringify(listed)).not.toContain(secret);

    await store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(fs.readFileSync(dbPath).toString('utf8')).not.toContain(secret);
    const db = new Database(dbPath, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(tool_runs)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    db.close();
    expect(columns).not.toEqual(expect.arrayContaining(['arguments', 'content', 'raw_url']));
  });

  it('terminalizes restored running rows instead of showing endless activity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-tool-recovery-'));
    directories.push(directory);
    const config = baseConfig({ dataDir: directory, dbPath: path.join(directory, 'helmora.db') });
    const store = new SqliteConfigStore(config);
    stores.push(store);
    const running = await store.recordToolRun({ ...auditInput(), status: 'running' });
    expect(await store.listToolRuns({ limit: 10 })).toContainEqual(running);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const restored = new SqliteConfigStore(config);
    stores.push(restored);

    const listed = await restored.listToolRuns({ limit: 10 });

    expect(listed).toContainEqual({
      ...running,
      status: 'failed',
      errorCode: 'run_interrupted',
    });
  });
});

describe('Supabase tool-run audit', () => {
  it('writes allowlisted columns to the dedicated table and returns bounded activity', async () => {
    const store = new SupabaseConfigStore(baseConfig({
      storageBackend: 'supabase',
      storageChoice: 'sql',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-role-test-only',
    }));
    const rows: Record<string, unknown>[] = [];
    const client = {
      from: (table: string) => {
        expect(table).toBe('helmora_tool_runs');
        return {
          insert: async (row: Record<string, unknown>) => {
            rows.push(row);
            return { error: null };
          },
          select: () => ({
            order: () => ({
              limit: async (limit: number) => ({ data: rows.slice(0, limit), error: null }),
            }),
          }),
        };
      },
    };
    (store as unknown as { client: typeof client }).client = client;
    const secret = 'supabase-secret-never-store';

    const saved = await store.recordToolRun({
      ...auditInput(),
      arguments: { query: secret },
      content: secret,
    } as ToolRunCreate);
    const listed = await store.listToolRuns({ limit: 10 });

    expect(saved).toMatchObject(auditInput());
    expect(listed).toEqual([saved]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining([
      'id', 'request_id', 'tool_id', 'connector', 'surface', 'source', 'status', 'created_at',
    ]));
    expect(Object.keys(rows[0]!)).not.toEqual(expect.arrayContaining(['arguments', 'content', 'raw_url']));
  });
});
