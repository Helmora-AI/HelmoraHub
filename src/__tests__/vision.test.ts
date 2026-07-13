import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeImagesIntoMessages,
  requestHasImages,
  estimatePromptTokensWithVision,
} from '../lib/vision.js';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

describe('vision helpers', () => {
  it('merges images[] into last user message', () => {
    const msgs = mergeImagesIntoMessages(
      [{ role: 'user', content: 'what is this?' }],
      ['https://example.com/a.png', 'data:image/png;base64,aaa']
    );
    expect(requestHasImages(msgs)).toBe(true);
    const content = msgs[0].content as Array<{ type: string }>;
    expect(content.some((p) => p.type === 'text')).toBe(true);
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });

  it('estimates extra tokens per image', () => {
    const msgs = mergeImagesIntoMessages([{ role: 'user', content: 'hi' }], [
      'https://example.com/x.jpg',
    ]);
    expect(estimatePromptTokensWithVision(msgs)).toBeGreaterThanOrEqual(85);
  });
});

describe('vision streaming API', () => {
  let app: Express;
  let tmpDir: string;
  let apiKey: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-vision-'));
    process.env.DATA_DIR = tmpDir;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-vision';
    process.env.STORAGE_BACKEND = 'local';
    process.env.RATE_BACKEND = 'memory';
    delete process.env.HELMORA_API_KEY;

    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.encryptionKey = 'test-encryption-key-vision';
    setActiveConfig(config);
    await initStorage(config);
    app = createApp(config);
    apiKey = await getConfigStore().getUnifiedApiKey();
  });

  afterAll(async () => {
    await closeStorage();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('streams with images helper and sets X-Ctrl-Vision', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'describe' }],
        images: ['https://example.com/cat.png'],
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-ctrl-vision']).toBe('1');
    const text = typeof res.body === 'string' ? res.body : String(res.body);
    expect(text).toContain('[DONE]');
    expect(text).toMatch(/vision:1|1 image/i);
  });

  it('accepts OpenAI content parts non-stream', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'auto',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what animal?' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/dog.jpg' },
              },
            ],
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.headers['x-ctrl-vision']).toBe('1');
    expect(res.body.choices[0].message.content).toMatch(/image/i);
  });
});
