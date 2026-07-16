import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request, { TEST_SETUP_TOKEN } from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

let app: Express;
let tmpDir: string;
let spaToken: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-chat-hist-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-chat-hist';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_TOKEN;
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.CTRLHUB_ADMIN_PASSWORD;
  process.env.HELMORA_SETUP_TOKEN = TEST_SETUP_TOKEN;
  delete process.env.ADMIN_PASSWORD;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-chat-hist';
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  const password = 'chat-hist-password';
  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password, setupToken: TEST_SETUP_TOKEN });
  if (setup.status === 200 && setup.body.token) {
    spaToken = setup.body.token;
  } else {
    const login = await request(app).post('/api/auth/login').send({ password });
    if (login.status !== 200 || !login.body.token) {
      throw new Error(
        `Auth bootstrap failed: setup=${setup.status} login=${login.status}`
      );
    }
    spaToken = login.body.token;
  }
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('Playground chat history API', () => {
  it('creates, lists, patches, and deletes sessions', async () => {
    const created = await request(app)
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        title: 'Hello',
        modelSelection: { kind: 'auto' },
        thinking: false,
      });
    expect(created.status).toBe(201);
    expect(created.body.session.id).toBeTruthy();
    expect(created.body.activeSessionId).toBe(created.body.session.id);

    const list = await request(app)
      .get('/api/chat/sessions')
      .set('Authorization', `Bearer ${spaToken}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(list.body.activeSessionId).toBe(created.body.session.id);

    const patched = await request(app)
      .patch(`/api/chat/sessions/${created.body.session.id}`)
      .set('Authorization', `Bearer ${spaToken}`)
      .send({ title: 'Renamed', thinking: true });
    expect(patched.status).toBe(200);
    expect(patched.body.session.title).toBe('Renamed');
    expect(patched.body.session.thinking).toBe(true);

    const del = await request(app)
      .delete(`/api/chat/sessions/${created.body.session.id}`)
      .set('Authorization', `Bearer ${spaToken}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.activeSessionId).toBeTruthy();
  });

  it('appends and paginates messages; cascades on delete', async () => {
    const created = await request(app)
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({});
    const id = created.body.session.id as string;

    const append = await request(app)
      .post(`/api/chat/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        messages: [
          { role: 'user', content: 'hi', status: 'complete' },
          { role: 'assistant', content: 'hello', status: 'complete' },
        ],
      });
    expect(append.status).toBe(201);
    expect(append.body.messages).toHaveLength(2);
    expect(append.body.messages[0].seq).toBe(1);

    const page = await request(app)
      .get(`/api/chat/sessions/${id}/messages?limit=1`)
      .set('Authorization', `Bearer ${spaToken}`);
    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(1);
    expect(page.body.hasMore).toBe(true);

    await request(app)
      .delete(`/api/chat/sessions/${id}`)
      .set('Authorization', `Bearer ${spaToken}`);

    const gone = await request(app)
      .get(`/api/chat/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${spaToken}`);
    expect(gone.status).toBe(404);
  });

  it('imports a browser store payload via store methods', async () => {
    const store = getConfigStore();
    const result = await store.importChatStore({
      activeThreadId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      threads: [
        {
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          title: 'Imported',
          modelSelection: { kind: 'auto' },
          thinking: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'from localStorage',
              status: 'complete',
              createdAt: new Date().toISOString(),
              seq: 1,
            },
          ],
        },
      ],
    });
    expect(result.importedSessions).toBe(1);
    expect(result.importedMessages).toBe(1);
    expect(result.activeThreadId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const detail = await store.getChatSession(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(detail?.messages[0]?.content).toBe('from localStorage');
  });

  it('rejects unauthenticated history access', async () => {
    const res = await request(app).get('/api/chat/sessions');
    expect(res.status).toBe(401);
  });
});
